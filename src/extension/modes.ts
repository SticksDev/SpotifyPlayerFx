// The three visualizers: each keeps its own memory, steps it once a frame,
// and draws it. Modelled on spotifast's player bar (src/vis.rs).
import { BANDS, CLASSIC_COLUMNS, CLASSIC_MAX, INTENSITY_LEVELS, SMOOTHING_LEVELS, type ModeId } from "./constants";
import { palette, rgba, sweep } from "./colors";
import { liveBands, liveTrace } from "./live";
import { settings } from "./settings";
import { reader } from "./sound";

// Winamp's bars cross the whole height in a third of a second.
const FALL = 0.75 / 15 / 0.016667; // heights per second
const PEAK_HOLD = 0.35; // seconds a cap hangs before dropping
const PEAK_GRAVITY = 2.4; // heights per second squared

const SPECTRUM_GAP = 2;
const PEAK_HEIGHT = 2;
const PEAK_GAP = 2;
const SPECTRUM_ALPHA_FOOT = 0.28;
const SPECTRUM_ALPHA_TOP = 0.08;
const GLOW_ALPHA = 0.12;
const PEAK_ALPHA = 0.7;
const PULSE_ALPHA = 0.35;

// [line width, alpha] from the widest glow to the core.
const WAVE_LAYERS = [
	[9, 0.06],
	[4, 0.16],
	[1.6, 0.85],
] as const;
const WAVE_FILL_ALPHA = 0.14;
const WAVE_ECHO_ALPHA = 0.18;

// Winamp's classic_vis.cpp.
const CLASSIC_BARS = 19;
const CLASSIC_ROWS = 16;
const CLASSIC_FALLOFF = 12 / 16;
const CLASSIC_PEAK_FALLOFF = 1.1;
const CLASSIC_STEP_MS = 16.667;
const CLASSIC_CATCH_UP = 2;
const CLASSIC_ALPHA = 0.34;

interface FrameInput {
	dt: number;
	now: number;
	posSec: number;
	playing: boolean;
	useLive: boolean;
	width: number;
}

const levels = new Float32Array(BANDS);
const peaks = new Float32Array(BANDS);
const peakHeld = new Float32Array(BANDS);
const peakSpeed = new Float32Array(BANDS);
const targets = new Float32Array(BANDS);

let trace = new Float32Array(0);
let traceActive = false;

// Classic memory, in rows.
const classicColumns = new Float32Array(CLASSIC_COLUMNS + 1);
const classicFalloff = new Float32Array(CLASSIC_BARS);
const classicPeaks = new Int32Array(CLASSIC_BARS); // 256ths of a row
const classicPeakSpeed = new Float32Array(CLASSIC_BARS);
const classicHeights = new Uint8Array(CLASSIC_BARS);
const classicPeakRows = new Uint8Array(CLASSIC_BARS); // 0 = out of sight
let classicLast = 0;

// Band targets eased between frames so a noisy feed doesn't shake the bars.
// The fall rate still applies on top.
const smoothed = new Float32Array(CLASSIC_COLUMNS + 1);

function readBands(out: Float32Array, count: number, useLive: boolean): void {
	if (useLive) liveBands(out, count);
	else reader.synthBands(out, count);
	const k = SMOOTHING_LEVELS[settings.smoothing].k;
	if (k >= 1) {
		smoothed.set(out.subarray(0, count));
		return;
	}
	for (let i = 0; i < count; i++) {
		smoothed[i] += (out[i] - smoothed[i]) * k;
		out[i] = smoothed[i];
	}
}

export function resetModes(): void {
	for (const a of [levels, peaks, peakHeld, peakSpeed, classicFalloff, classicPeaks, classicPeakSpeed, classicHeights, classicPeakRows, smoothed]) {
		a.fill(0);
	}
	classicLast = 0;
}

// Returns whether anything is still moving, so the loop knows when to rest.
export function stepMode(mode: ModeId, f: FrameInput): boolean {
	if (mode === "spectrum") return stepSpectrum(f.dt, f.useLive);
	if (mode === "waveform") return stepWaveform(f.width, f.posSec, f.playing, f.useLive);
	if (mode === "classic") return stepClassic(f.now, f.useLive);
	return false;
}

export function drawMode(mode: ModeId, ctx: CanvasRenderingContext2D, width: number, height: number): void {
	const strength = INTENSITY_LEVELS[settings.intensity].strength;
	if (mode === "spectrum") drawSpectrum(ctx, width, height, strength);
	else if (mode === "waveform") drawWaveform(ctx, width, height, strength);
	else if (mode === "classic") drawClassic(ctx, width, height, strength);
}

// Spectrum: up at once, down at Winamp's rate.
function stepSpectrum(dt: number, useLive: boolean): boolean {
	readBands(targets, BANDS, useLive);
	let moving = false;
	for (let i = 0; i < BANDS; i++) {
		let level = Math.max(levels[i] - FALL * dt, targets[i]);
		if (level < 0.01) level = 0;
		levels[i] = level;

		if (level >= peaks[i]) {
			peaks[i] = level;
			peakHeld[i] = 0;
			peakSpeed[i] = 0;
		} else if (peakHeld[i] < PEAK_HOLD) {
			peakHeld[i] += dt;
		} else {
			peakSpeed[i] += PEAK_GRAVITY * dt;
			peaks[i] = Math.max(peaks[i] - peakSpeed[i] * dt, level);
		}
		if (peaks[i] < 0.01) peaks[i] = 0;
		if (level > 0 || peaks[i] > 0) moving = true;
	}
	return moving;
}

function drawSpectrum(ctx: CanvasRenderingContext2D, width: number, height: number, strength: number): void {
	const colours = sweep(BANDS);
	const bandW = (width - SPECTRUM_GAP * (BANDS - 1)) / BANDS;
	// A full band reaches the top, with room above for its cap.
	const reach = height - PEAK_GAP - PEAK_HEIGHT - 1;

	if (settings.bassPulse) {
		const n = Math.max(1, BANDS >> 3);
		let bass = 0;
		for (let i = 0; i < n; i++) bass += levels[i];
		bass /= n;
		const a = Math.min(1, PULSE_ALPHA * strength * bass * bass);
		if (a > 0.003) {
			const g = ctx.createLinearGradient(0, height / 2, 0, height);
			g.addColorStop(0, rgba(palette.low, 0));
			g.addColorStop(1, rgba(palette.low, a));
			ctx.fillStyle = g;
			ctx.fillRect(0, height / 2, width, height / 2);
		}
	}

	const foot = SPECTRUM_ALPHA_FOOT * strength;
	const top = SPECTRUM_ALPHA_TOP * strength;

	for (let i = 0; i < BANDS; i++) {
		const left = i * (bandW + SPECTRUM_GAP);
		const c = colours[i];
		const level = levels[i];
		const h = level * reach;
		if (h >= 1) {
			const y = height - h;
			// The glow: the bar again, wider and fainter.
			const glow = ctx.createLinearGradient(0, y - 3, 0, height + 3);
			glow.addColorStop(0, `rgba(${c},${Math.min(1, GLOW_ALPHA * strength * 0.3)})`);
			glow.addColorStop(1, `rgba(${c},${Math.min(1, GLOW_ALPHA * strength)})`);
			ctx.fillStyle = glow;
			ctx.fillRect(left - SPECTRUM_GAP, y - 3, bandW + SPECTRUM_GAP * 2, h + 6);
			const bar = ctx.createLinearGradient(0, y, 0, height);
			bar.addColorStop(0, `rgba(${c},${Math.min(1, foot + (top - foot) * level)})`);
			bar.addColorStop(1, `rgba(${c},${Math.min(1, foot)})`);
			ctx.fillStyle = bar;
			ctx.fillRect(left, y, bandW, h);
		}
		if (settings.peakCaps) {
			const cap = peaks[i] * reach;
			if (cap >= 2) {
				ctx.fillStyle = `rgba(${c},${PEAK_ALPHA})`;
				ctx.fillRect(left, height - cap - PEAK_GAP - PEAK_HEIGHT, bandW, PEAK_HEIGHT);
			}
		}
	}
}

function stepWaveform(width: number, posSec: number, playing: boolean, useLive: boolean): boolean {
	const count = Math.max(75, Math.min(320, Math.round(width / 8)));
	if (trace.length !== count) trace = new Float32Array(count);
	// No sound, no line: spotifast doesn't draw a flat one either.
	traceActive = playing;
	if (!playing) return false;
	if (useLive) {
		liveTrace(trace);
		return true;
	}
	reader.synthTrace(trace, posSec);
	// Winamp's sixteen rows span half of full scale.
	for (let i = 0; i < count; i++) trace[i] = Math.max(-1, Math.min(1, trace[i] * 2));
	return true;
}

function drawWaveform(ctx: CanvasRenderingContext2D, width: number, height: number, strength: number): void {
	const n = trace.length;
	if (n < 2 || !traceActive) return;
	const colours = sweep(n);
	const reach = height * 0.46;
	const stepX = width / (n - 1);
	const midline = height / 2;
	const px = (i: number) => i * stepX;
	const py = (v: number) => midline - v * reach;

	// Shading between the wave and the midline.
	const fillA = Math.min(1, WAVE_FILL_ALPHA * strength);
	for (let i = 0; i < n - 1; i++) {
		const g = ctx.createLinearGradient(0, Math.min(py(trace[i]), py(trace[i + 1])), 0, midline);
		g.addColorStop(0, `rgba(${colours[i]},${fillA})`);
		g.addColorStop(1, `rgba(${colours[i]},0)`);
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.moveTo(px(i), py(trace[i]));
		ctx.lineTo(px(i + 1), py(trace[i + 1]));
		ctx.lineTo(px(i + 1), midline);
		ctx.lineTo(px(i), midline);
		ctx.closePath();
		ctx.fill();
	}

	// Short runs of line, so the colour can sweep along the wave.
	const run = 8;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	const stroke = (mirror: number, lineWidth: number, alpha: number) => {
		ctx.lineWidth = lineWidth;
		for (let start = 0; start < n - 1; ) {
			const end = Math.min(start + run, n - 1);
			ctx.strokeStyle = `rgba(${colours[(start + end) >> 1]},${alpha})`;
			ctx.beginPath();
			ctx.moveTo(px(start), py(trace[start] * mirror));
			for (let i = start + 1; i <= end; i++) ctx.lineTo(px(i), py(trace[i] * mirror));
			ctx.stroke();
			start = end;
		}
	};
	stroke(-0.6, 1, WAVE_ECHO_ALPHA);
	for (const [w, a] of WAVE_LAYERS) stroke(1, w, a);
}

// Classic: Winamp's analyser, 19 bars in 16 rows on its own 60 Hz clock.
function stepClassic(now: number, useLive: boolean): boolean {
	// Keep the step's own beat when frames come early or late; frames at
	// half rate owe two steps so the bars fall as fast as at full rate.
	const due = classicLast ? classicLast + CLASSIC_STEP_MS : now;
	if (now + 1 < due) return classicHeights.some((h) => h > 0) || classicPeakRows.some((p) => p > 0);
	const behind = Math.floor(Math.max(0, now - due) / CLASSIC_STEP_MS);
	const owed = Math.min(1 + behind, CLASSIC_CATCH_UP);
	classicLast = Math.max(due + CLASSIC_STEP_MS * (owed - 1), now - CLASSIC_STEP_MS);

	readBands(classicColumns, CLASSIC_COLUMNS, useLive);
	classicColumns[CLASSIC_COLUMNS] = 0;
	let moving = false;
	for (let bar = 0; bar < CLASSIC_BARS; bar++) {
		const chunk = 4 * bar;
		const sound = (classicColumns[chunk] + classicColumns[chunk + 1] + classicColumns[chunk + 2] + classicColumns[chunk + 3]) / 4;
		// Winamp kept the target as a whole number of rows.
		const target = Math.trunc(Math.min(sound * CLASSIC_MAX * 1.15, CLASSIC_MAX));
		let peakRow = 0;
		for (let k = 0; k < owed; k++) {
			const falloff = Math.max(classicFalloff[bar] - CLASSIC_FALLOFF, target);
			classicFalloff[bar] = falloff;
			let peak = classicPeaks[bar];
			if (peak <= Math.round(falloff * 256)) {
				peak = Math.trunc(falloff * 256);
				classicPeakSpeed[bar] = 3;
			}
			peakRow = Math.trunc(peak / 256);
			peak -= Math.round(classicPeakSpeed[bar]);
			classicPeakSpeed[bar] *= CLASSIC_PEAK_FALLOFF;
			classicPeaks[bar] = Math.max(peak, 0);
		}
		classicHeights[bar] = Math.round(classicFalloff[bar]);
		classicPeakRows[bar] = peakRow >= 1 ? peakRow + 1 : 0;
		if (classicHeights[bar] > 0 || classicPeakRows[bar] > 0) moving = true;
	}
	return moving;
}

function drawClassic(ctx: CanvasRenderingContext2D, width: number, height: number, strength: number): void {
	// Seventy-five skin columns across: each bar three wide, one between.
	const colW = width / (CLASSIC_COLUMNS + 1);
	const barW = colW * 3;
	const rowH = (height - 4) / CLASSIC_ROWS;
	const gap = Math.max(1, Math.min(2, rowH * 0.2));
	const colours = sweep(CLASSIC_ROWS); // bottom row low, top row high
	const alpha = Math.min(1, CLASSIC_ALPHA * strength);
	const bottom = height - 2;

	for (let bar = 0; bar < CLASSIC_BARS; bar++) {
		const left = bar * 4 * colW + colW * 0.5;
		for (let row = 0; row < classicHeights[bar]; row++) {
			const y = bottom - (row + 1) * rowH;
			ctx.fillStyle = `rgba(${colours[row]},${alpha})`;
			ctx.fillRect(left, y + gap, barW, rowH - gap);
		}
		const p = classicPeakRows[bar];
		if (settings.peakCaps && p >= 1) {
			const row = Math.min(p, CLASSIC_ROWS) - 1;
			const y = bottom - (row + 1) * rowH;
			ctx.fillStyle = `rgba(${colours[row]},${PEAK_ALPHA})`;
			ctx.fillRect(left, y + gap, barW, Math.max(1, rowH - gap));
		}
	}
}
