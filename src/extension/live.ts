// Live audio from the companion (opt in): a sliding window of Spotify's own
// output over a WebSocket on 127.0.0.1, run through Winamp's FFT and bands.
import { CLASSIC_COLUMNS, CLASSIC_MAX, SCOPE_STEP } from "./constants";
import { emitChange, settings } from "./settings";

const FFT_SAMPLES = 512;
const SPECTRUM_BINS = FFT_SAMPLES / 2;
const CHANNEL_SUM = 2.0; // the companion sends the channel mean; Winamp used the sum
const SPEC_SCALE = 0.5; // Winamp's own scale on every magnitude
const STALE_MS = 400;
const SILENT_MS = 2000;
const RETRY_MIN_MS = 3000;
const RETRY_MAX_MS = 30000;

export type LiveStatus = "off" | "connecting" | "no-spotify" | "silent" | "live";

export const live = {
	ws: null as WebSocket | null,
	connected: false,
	spotify: false,
	samples: new Float32Array(0),
	lastMessageAt: 0,
	retryTimer: 0,
	retryMs: RETRY_MIN_MS,
};

export function liveStatus(): LiveStatus {
	if (!settings.liveAudio) return "off";
	if (!live.connected) return "connecting";
	if (!live.spotify) return "no-spotify";
	if (performance.now() - live.lastMessageAt > SILENT_MS) return "silent";
	return "live";
}

export function isLive(): boolean {
	return settings.liveAudio && live.connected && live.spotify && performance.now() - live.lastMessageAt < STALE_MS;
}

// Drops any connection and, if live audio is on, connects again right away.
export function restartLive(): void {
	clearTimeout(live.retryTimer);
	live.retryTimer = 0;
	live.retryMs = RETRY_MIN_MS;
	const old = live.ws;
	live.ws = null;
	old?.close();
	live.connected = false;
	live.spotify = false;
	if (settings.liveAudio) connect();
}

function connect(): void {
	const ws = new WebSocket(`ws://127.0.0.1:${settings.companionPort}/`);
	ws.binaryType = "arraybuffer";
	live.ws = ws;
	ws.onopen = () => {
		live.connected = true;
		live.retryMs = RETRY_MIN_MS;
		emitChange();
	};
	ws.onmessage = (ev) => {
		if (typeof ev.data === "string") {
			try {
				const msg = JSON.parse(ev.data);
				if (typeof msg.spotify === "boolean") live.spotify = msg.spotify;
			} catch {}
			emitChange();
			return;
		}
		const pcm = new Int16Array(ev.data as ArrayBuffer);
		if (live.samples.length !== pcm.length) live.samples = new Float32Array(pcm.length);
		for (let i = 0; i < pcm.length; i++) live.samples[i] = pcm[i] / 32768;
		const now = performance.now();
		const wasSilent = now - live.lastMessageAt > SILENT_MS;
		live.lastMessageAt = now;
		if (wasSilent) emitChange();
	};
	ws.onclose = () => {
		if (live.ws !== ws) return; // replaced by restartLive
		live.ws = null;
		live.connected = false;
		live.spotify = false;
		emitChange();
		// Back off while the companion isn't running; each failed attempt
		// logs an error in Spotify's console.
		live.retryTimer = window.setTimeout(() => {
			live.retryTimer = 0;
			if (settings.liveAudio) connect();
		}, live.retryMs);
		live.retryMs = Math.min(live.retryMs * 2, RETRY_MAX_MS);
	};
}

// The `count` newest samples, silence where there are fewer.
function latestSamples(out: Float32Array, count: number): void {
	const src = live.samples;
	const take = Math.min(count, src.length);
	out.fill(0, 0, count - take);
	out.set(src.subarray(src.length - take), count - take);
}

// Winamp's FFT: 512 samples under a Hann window, 256 magnitudes out, each
// halved. Ported from spotifast's vis.rs.
class Fft {
	private readonly bitReversed: Int32Array;
	private readonly envelope: Float32Array;
	private readonly twiddles: Array<[number, number]> = [];
	private readonly real: Float32Array;
	private readonly imag: Float32Array;

	constructor(private readonly n: number) {
		const rev = new Int32Array(n);
		for (let i = 0; i < n; i++) rev[i] = i;
		let j = 0;
		for (let i = 0; i < n; i++) {
			if (j > i) {
				const t = rev[i];
				rev[i] = rev[j];
				rev[j] = t;
			}
			let m = n >> 1;
			while (m >= 1 && j >= m) {
				j -= m;
				m >>= 1;
			}
			j += m;
		}
		this.bitReversed = rev;
		this.envelope = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			this.envelope[i] = 0.5 + 0.5 * Math.sin((i / n) * 6.283185307 - 1.5707963);
		}
		for (let size = 2; size <= n; size <<= 1) {
			const theta = -6.283185307 / size;
			this.twiddles.push([Math.cos(theta), Math.sin(theta)]);
		}
		this.real = new Float32Array(n);
		this.imag = new Float32Array(n);
	}

	spectrum(wave: Float32Array, out: Float32Array): void {
		const { n, real, imag, bitReversed, envelope, twiddles } = this;
		for (let i = 0; i < n; i++) {
			const from = bitReversed[i];
			real[i] = (from < wave.length ? wave[from] : 0) * envelope[from];
			imag[i] = 0;
		}
		let stage = 0;
		for (let size = 2; size <= n; size <<= 1) {
			const [wpr, wpi] = twiddles[stage++];
			let wr = 1;
			let wi = 0;
			const half = size >> 1;
			for (let m = 0; m < half; m++) {
				for (let i = m; i < n; i += size) {
					const j = i + half;
					const tr = wr * real[j] - wi * imag[j];
					const ti = wr * imag[j] + wi * real[j];
					real[j] = real[i] - tr;
					imag[j] = imag[i] - ti;
					real[i] += tr;
					imag[i] += ti;
				}
				const prev = wr;
				wr = wr * wpr - wi * wpi;
				wi = wi * wpr + prev * wpi;
			}
		}
		for (let i = 0; i < out.length; i++) {
			out[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) * SPEC_SCALE;
		}
	}
}

// Winamp's own bands, from its published source: seventy-five spans a
// semitone apart (2^(x/12)), each summing its share of the 256 bins, the
// fractional edges read through a Hermite curve, the sum clipped at 255.
function winampBands(spectrum: Float32Array, columns: Float32Array): void {
	const bla = 255 / Math.pow(2, 75 / 12);
	const warp = (x: number) => (Math.pow(2, x / 12) - 1) * bla;
	const sample = (i: number) => (i >= 0 && i < SPECTRUM_BINS ? spectrum[i] : 0);
	const hermite = (x: number, y0: number, y1: number, y2: number, y3: number) => {
		const c1 = 0.5 * (y2 - y0);
		const c3 = 1.5 * (y1 - y2) + 0.5 * (y3 - y0);
		const c2 = y0 - y1 + c1 - c3;
		return ((c3 * x + c2) * x + c1) * x + y1;
	};
	let next = warp(0) + 1;
	for (let x = 0; x < CLASSIC_COLUMNS; x++) {
		const low = next;
		next = warp(x + 1) + 1;
		let value = 0;
		let bin = Math.floor(low);
		const end = Math.min(Math.floor(next), SPECTRUM_BINS - 1);
		let fraction = low;
		let mult = bin + 1 - low;
		let herm = true;
		for (;;) {
			if (bin === end) {
				mult = next - fraction;
				herm = true;
			}
			if (herm) {
				value += hermite(fraction - bin, sample(Math.max(bin - 1, 0)), sample(bin), sample(bin + 1), sample(bin + 2)) * mult;
			} else {
				value += sample(bin);
			}
			herm = false;
			bin += 1;
			if (bin > end) break;
			fraction = bin;
		}
		columns[x] = Math.min(value, 255);
	}
	columns[CLASSIC_COLUMNS] = 0;
}

const fft = new Fft(FFT_SAMPLES);
const fftWave = new Float32Array(FFT_SAMPLES);
const fftSpectrum = new Float32Array(SPECTRUM_BINS);
const fftSpectrum2 = new Float32Array(SPECTRUM_BINS);
const fftWindow = new Float32Array(FFT_SAMPLES + FFT_SAMPLES / 2);
const liveColumns = new Float32Array(CLASSIC_COLUMNS + 1);
const scopeWindow = new Float32Array(320 * SCOPE_STEP);

// Bands as 0..1 heights. Two FFTs half a window apart are averaged, which
// halves the frame-to-frame variance without blurring time much.
export function liveBands(out: Float32Array, count: number): void {
	latestSamples(fftWindow, fftWindow.length);
	for (let i = 0; i < fftWindow.length; i++) fftWindow[i] *= CHANNEL_SUM;
	fftWave.set(fftWindow.subarray(0, FFT_SAMPLES));
	fft.spectrum(fftWave, fftSpectrum2);
	fftWave.set(fftWindow.subarray(FFT_SAMPLES / 2));
	fft.spectrum(fftWave, fftSpectrum);
	for (let i = 0; i < SPECTRUM_BINS; i++) fftSpectrum[i] = (fftSpectrum[i] + fftSpectrum2[i]) * 0.5;
	winampBands(fftSpectrum, liveColumns);
	for (let i = 0; i < count; i++) out[i] = Math.min(liveColumns[i], CLASSIC_MAX) / CLASSIC_MAX;
}

// Winamp's scope: every seventh sample, unsmoothed, at double gain so
// anything past half scale reaches the edge.
export function liveTrace(out: Float32Array): void {
	const n = out.length;
	latestSamples(scopeWindow, n * SCOPE_STEP);
	for (let i = 0; i < n; i++) {
		const v = scopeWindow[i * SCOPE_STEP] * 2;
		out[i] = v < -1 ? -1 : v > 1 ? 1 : v;
	}
}
