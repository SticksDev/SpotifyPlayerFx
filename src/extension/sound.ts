// The sound at the playhead when there is no live audio: Spotify's analysis
// of the track, or failing that its audio features, synthesised into bands
// and a waveform.
import { BANDS, SCOPE_STEP } from "./constants";

const SAMPLE_RATE = 44100;

interface Segment {
	start: number;
	duration: number;
	loudness_start: number;
	loudness_max: number;
	loudness_max_time: number;
	pitches?: number[];
	timbre?: number[];
}

interface Beat {
	start: number;
	duration: number;
	confidence?: number;
}

interface Analysis {
	segments: Segment[];
	beats: Beat[];
	loudness: number;
}

interface Features {
	tempo: number;
	energy: number;
	danceability: number;
	valence: number;
	key: number;
	major: boolean;
}

interface TrackSound {
	analysis: Analysis | null;
	features: Features | null;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function hash01(n: number): number {
	const x = Math.sin(n * 12.9898) * 43758.5453;
	return x - Math.floor(x);
}

// Not every track has an analysis any more (Spotify has been dropping them
// since the public API went), so audio features are the fallback. A 404 is
// final and cached; other failures are retried a few times.
const cache = new Map<string, TrackSound>();
const CACHE_LIMIT = 24;
const FETCH_RETRIES = 3;
const FETCH_RETRY_MS = 2500;

const isTransient = (res: any) => !res || (typeof res.code === "number" && res.code !== 404);

function trackId(uri: string): string | null {
	try {
		const u = Spicetify.URI.from ? Spicetify.URI.from(uri) : Spicetify.URI.fromString(uri);
		return u ? (u.getBase62Id ? u.getBase62Id() : u.id) : null;
	} catch {
		return null;
	}
}

// These resolve to null when the track has no data and throw when the
// request failed in a way worth retrying.
async function fetchAnalysis(uri: string): Promise<Analysis | null> {
	let res: any;
	try {
		res = await Spicetify.getAudioData(uri);
	} catch {
		return null; // invalid URI, or the API is gone
	}
	if (Array.isArray(res?.segments) && res.segments.length) {
		return {
			segments: res.segments,
			beats: Array.isArray(res.beats) ? res.beats : [],
			loudness: typeof res.track?.loudness === "number" ? res.track.loudness : -12,
		};
	}
	if (isTransient(res)) throw new Error("analysis unavailable");
	return null;
}

async function fetchFeatures(uri: string): Promise<Features | null> {
	const id = trackId(uri);
	if (!id) return null;
	// Internal endpoint; the public Web API no longer serves audio features.
	const res = await Spicetify.CosmosAsync.get(`https://spclient.wg.spotify.com/audio-attributes/v1/audio-features/${id}?format=json`);
	if (typeof res?.tempo === "number" && res.tempo > 0) {
		return {
			tempo: res.tempo,
			energy: clamp01(res.energy ?? 0.5),
			danceability: clamp01(res.danceability ?? 0.5),
			valence: clamp01(res.valence ?? 0.5),
			key: typeof res.key === "number" && res.key >= 0 ? res.key : 0,
			major: res.mode !== 0,
		};
	}
	if (isTransient(res)) throw new Error("features unavailable");
	return null;
}

// null means "try again later"; a TrackSound with nothing in it is final.
async function fetchSound(uri: string): Promise<TrackSound | null> {
	let failed = false;
	const fail = () => {
		failed = true;
		return null;
	};
	const analysis = await fetchAnalysis(uri).catch(fail);
	const features = analysis ? null : await fetchFeatures(uri).catch(fail);
	if (!analysis && !features && failed) return null;
	return { analysis, features };
}

export async function loadSound(uri: string, stillCurrent: () => boolean): Promise<TrackSound | null> {
	const cached = cache.get(uri);
	if (cached) return cached;
	for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
		if (attempt) await new Promise((r) => setTimeout(r, FETCH_RETRY_MS));
		if (!stillCurrent()) return null;
		const sound = await fetchSound(uri);
		if (sound) {
			if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
			cache.set(uri, sound);
			return sound;
		}
	}
	return null;
}

function findIndex(list: { start: number }[], pos: number, hint: number): number {
	let i = hint;
	if (i < 0 || i >= list.length) i = 0;
	if (list[i].start > pos) {
		let lo = 0;
		let hi = i;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (list[mid].start <= pos) lo = mid + 1;
			else hi = mid;
		}
		i = Math.max(0, lo - 1);
	} else {
		while (i + 1 < list.length && list[i + 1].start <= pos) i++;
	}
	return i;
}

// Normalise around the track's average loudness so quiet and loud masters
// fill the display alike, the way Winamp's 15-of-255 scale always did.
function loudnessToLinear(db: number, trackLoudness: number): number {
	const floor = trackLoudness - 24;
	const ceil = trackLoudness + 4;
	return clamp01((db - floor) / (ceil - floor));
}

// Without an analysis, a groove from the track's features: the beat from
// its tempo, the lift from its energy, a chord in its key with a melody
// note that steps each beat, so the bands change the way a song's would.
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PROGRESSION = [0, 5, 3, 4]; // scale degrees of I, vi, IV, V

// Per-band texture so neighbouring semitones never move as one block.
const seeds = new Float32Array(BANDS);
for (let i = 0; i < BANDS; i++) seeds[i] = hash01(i * 7919 + 13);

class SoundReader {
	readonly sound = { env: 0, pulse: 0, pitches: null as ArrayLike<number> | null, brightness: 0.5, segSeed: 0 };
	analysis: Analysis | null = null;
	features: Features | null = null;
	private featurePitches = new Float32Array(12);
	private featureBeat = -1;
	private segIndex = 0;
	private beatIndex = 0;

	reset(): void {
		this.analysis = null;
		this.features = null;
		this.featureBeat = -1;
		this.segIndex = 0;
		this.beatIndex = 0;
	}

	private readFeatures(posSec: number, f: Features): void {
		const s = this.sound;
		const beatLen = 60 / f.tempo;
		const beat = Math.floor(posSec / beatLen);
		const phase = posSec / beatLen - beat;
		const bar = Math.floor(beat / 4);

		if (beat !== this.featureBeat) {
			this.featureBeat = beat;
			const scale = f.major ? MAJOR : MINOR;
			const p = this.featurePitches;
			for (let k = 0; k < 12; k++) p[k] = 0.04 + 0.08 * hash01(beat * 13 + k);
			const rootDeg = PROGRESSION[Math.floor(hash01(bar * 17 + 3) * PROGRESSION.length)];
			const root = (f.key + scale[rootDeg]) % 12;
			p[root] = Math.max(p[root], 0.85);
			const third = (root + (f.major ? 4 : 3)) % 12;
			p[third] = Math.max(p[third], 0.6);
			p[(root + 7) % 12] = Math.max(p[(root + 7) % 12], 0.7);
			const melody = (f.key + scale[Math.floor(hash01(beat * 7 + 1) * scale.length)]) % 12;
			p[melody] = 1;
		}

		s.pulse = Math.exp(-phase * 4.5) * (0.5 + 0.5 * f.danceability);
		const baseline = 0.3 + 0.5 * f.energy;
		const swell = 0.85 + 0.15 * Math.sin((posSec / (beatLen * 8)) * 6.283185307);
		s.env = clamp01(baseline * (0.72 + 0.45 * s.pulse) * swell);
		s.pitches = this.featurePitches;
		s.brightness = 0.35 + 0.45 * f.energy;
		s.segSeed = hash01(beat * 31 + 7);
	}

	read(posSec: number, playing: boolean): void {
		const s = this.sound;
		const a = this.analysis;
		if (!playing || (!a && !this.features)) {
			s.env = 0;
			s.pulse = 0;
			s.pitches = null;
			return;
		}
		if (!a) {
			this.readFeatures(posSec, this.features!);
			return;
		}
		const segs = a.segments;
		this.segIndex = findIndex(segs, posSec, this.segIndex);
		const seg = segs[this.segIndex];
		const next = segs[this.segIndex + 1];

		// Loudness inside the segment: attack to the max, then decay towards
		// the next segment's start.
		const t = Math.max(0, posSec - seg.start);
		const lmt = Math.max(seg.loudness_max_time, 0.005);
		let db: number;
		if (t < lmt) {
			db = lerp(seg.loudness_start, seg.loudness_max, t / lmt);
		} else {
			const tail = Math.max(seg.duration - lmt, 0.01);
			const endDb = next ? next.loudness_start : seg.loudness_max - 12;
			db = lerp(seg.loudness_max, endDb, clamp01((t - lmt) / tail));
		}
		s.env = loudnessToLinear(db, a.loudness);

		// The beat lifts the low end.
		s.pulse = 0;
		if (a.beats.length) {
			this.beatIndex = findIndex(a.beats, posSec, this.beatIndex);
			const b = a.beats[this.beatIndex];
			const phase = clamp01((posSec - b.start) / Math.max(b.duration, 0.05));
			s.pulse = Math.exp(-phase * 5) * (b.confidence ?? 0.5);
		}

		s.pitches = seg.pitches || null;
		s.brightness = clamp01((seg.timbre?.[1] ?? 0) / 160 + 0.5);
		s.segSeed = hash01(this.segIndex * 31 + 7);
	}

	// Semitone bands (0..1): the twelve chroma bins repeat up the octaves, as
	// a real analyser shows a note and its harmonics; dull segments fall away
	// with frequency, bright ones stay flat.
	synthBands(out: Float32Array, count: number): void {
		const s = this.sound;
		if (!s.pitches || s.env <= 0) {
			out.fill(0);
			return;
		}
		const tiltK = 2.4 - 1.9 * s.brightness;
		for (let i = 0; i < count; i++) {
			const u = i / (count - 1);
			const chroma = s.pitches[(i + 5) % 12] ?? 0;
			const tilt = Math.exp(-tiltK * u);
			const texture = 0.5 + 0.5 * Math.sin(seeds[i % BANDS] * 6.283 + s.segSeed * 12.566);
			let v = s.env * ((0.18 + 0.82 * chroma) * tilt * (0.75 + 0.25 * texture) + 0.08 * texture);
			v *= 1 + 0.5 * s.pulse * (1 - u);
			// Winamp's scale clipped hard, which kept the display alive.
			out[i] = clamp01(v * 1.35);
		}
	}

	// A stretch of waveform (-1..1): the chroma bins as tones around A2, their
	// octave at half weight, with a little grain, read every seventh sample
	// from the playhead as Winamp's scope did, so it trembles.
	synthTrace(out: Float32Array, posSec: number): void {
		const s = this.sound;
		const p = s.pitches;
		let norm = 0;
		if (p && s.env > 0) for (let k = 0; k < 12; k++) norm += (p[k] ?? 0) * 1.5;
		if (!p || norm < 0.001) {
			out.fill(0);
			return;
		}
		const amp = (s.env * (0.55 + 0.25 * s.pulse)) / norm;
		const dt = SCOPE_STEP / SAMPLE_RATE;
		for (let i = 0; i < out.length; i++) {
			const t = posSec + i * dt;
			let v = 0;
			for (let k = 0; k < 12; k++) {
				const w = p[k] ?? 0;
				if (w < 0.03) continue;
				const ph = 6.283185307 * 110 * Math.pow(2, k / 12) * t;
				v += w * (Math.sin(ph) + 0.5 * Math.sin(2 * ph + 1.3 + k));
			}
			// Grain, noisier in brighter segments.
			v += (hash01(i * 3 + Math.floor(t * 200)) - 0.5) * 0.15 * s.brightness * norm;
			out[i] = Math.max(-1, Math.min(1, v * amp));
		}
	}
}

export const reader = new SoundReader();
