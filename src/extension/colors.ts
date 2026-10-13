// Colours from the cover art, after spotifast's vis_colours.
import { settings } from "./settings";

type Rgb = [number, number, number];

const FALLBACK_BASE: Rgb = [29, 185, 84];
// The most luminance a visualizer colour may have over the dark bar, so the
// white text in front of it stays readable.
const DARK_CEILING = 0.35;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const rgba = (c: Rgb, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function rgbToHsv([r, g, b]: Rgb): [number, number, number] {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	let h = 0;
	if (d > 0) {
		if (max === r) h = ((g - b) / d) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h /= 6;
		if (h < 0) h += 1;
	}
	return [h, max === 0 ? 0 : d / max, max];
}

function hsvToRgb([h, s, v]: [number, number, number]): Rgb {
	const i = Math.floor(h * 6);
	const f = h * 6 - i;
	const p = v * (1 - s);
	const q = v * (1 - f * s);
	const t = v * (1 - (1 - f) * s);
	const [r, g, b] = [
		[v, t, p],
		[q, v, p],
		[p, v, t],
		[p, q, v],
		[t, p, v],
		[v, p, q],
	][i % 6];
	return [r * 255, g * 255, b * 255];
}

// Keep the hue, bring the brightness under the ceiling (in linear light).
function darken(rgb: Rgb): Rgb {
	const lin = rgb.map((c) => srgbToLinear(c / 255));
	const lum = luminance(lin);
	const out = lum > DARK_CEILING ? lin.map((c) => c * (DARK_CEILING / lum)) : lin;
	return out.map((c) => Math.round(linearToSrgb(Math.min(1, c)) * 255)) as Rgb;
}

// The cover's colour made vivid for the bass, the same turned a sixth of the
// way round the wheel for the treble.
function paletteFrom(base: Rgb) {
	const [h, s] = rgbToHsv(base);
	const sat = Math.max(s, 0.55);
	return {
		low: darken(hsvToRgb([h, sat, 1])),
		high: darken(hsvToRgb([(h + 1 / 6) % 1, sat, 1])),
		accent: hsvToRgb([h, sat, 0.85]).map(Math.round) as Rgb,
	};
}

export let palette = paletteFrom(FALLBACK_BASE);

// Gamma-space blend from low to high, cached per band count.
const sweepCache = new Map<number, string[]>();

export function sweep(count: number): string[] {
	let arr = sweepCache.get(count);
	if (arr) return arr;
	arr = new Array<string>(count);
	for (let i = 0; i < count; i++) {
		const t = count > 1 ? i / (count - 1) : 0;
		const c = palette.low.map((v, k) => Math.round(v + (palette.high[k] - v) * t));
		arr[i] = `${c[0]},${c[1]},${c[2]}`;
	}
	sweepCache.set(count, arr);
	return arr;
}

function coverUrl(): string | null {
	const item = Spicetify.Player.data?.item || Spicetify.Player.data?.track;
	const m = item?.metadata;
	const raw: string | undefined = m && (m.image_url || m.image_large_url || m.image_xlarge_url);
	if (raw?.startsWith("spotify:image:")) return `https://i.scdn.co/image/${raw.slice(14)}`;
	if (raw?.startsWith("http")) return raw;
	return null;
}

// Sample the artwork and pick the most saturated mid-luminance colour.
function colourFromImage(url: string): Promise<Rgb | null> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.onload = () => {
			try {
				const size = 40;
				const c = document.createElement("canvas");
				c.width = size;
				c.height = size;
				const cx = c.getContext("2d", { willReadFrequently: true })!;
				cx.drawImage(img, 0, 0, size, size);
				resolve(pickDominant(cx.getImageData(0, 0, size, size).data));
			} catch (e) {
				reject(e);
			}
		};
		img.onerror = () => reject(new Error("artwork load failed"));
		img.src = url;
	});
}

function pickDominant(px: Uint8ClampedArray): Rgb | null {
	const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
	for (let i = 0; i < px.length; i += 4) {
		if (px[i + 3] < 128) continue;
		const r = px[i];
		const g = px[i + 1];
		const b = px[i + 2];
		const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
		let e = bins.get(key);
		if (!e) {
			e = { n: 0, r: 0, g: 0, b: 0 };
			bins.set(key, e);
		}
		e.n++;
		e.r += r;
		e.g += g;
		e.b += b;
	}
	let best: Rgb | null = null;
	let bestScore = -1;
	let fallback: Rgb | null = null;
	let fallbackN = -1;
	for (const e of bins.values()) {
		const r = e.r / e.n;
		const g = e.g / e.n;
		const b = e.b / e.n;
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
		const sat = max === 0 ? 0 : (max - min) / max;
		if (e.n > fallbackN && lum > 0.15 && lum < 0.9) {
			fallbackN = e.n;
			fallback = [r, g, b];
		}
		if (sat < 0.3 || lum < 0.18 || lum > 0.85) continue;
		const score = e.n * (0.4 + sat) * (1 - Math.abs(lum - 0.5));
		if (score > bestScore) {
			bestScore = score;
			best = [r, g, b];
		}
	}
	const pick = best || fallback;
	return pick ? (pick.map(Math.round) as Rgb) : null;
}

function hexToRgb(hex: unknown): Rgb | null {
	if (typeof hex !== "string") return null;
	const h = hex.replace("#", "");
	const n = parseInt(h, 16);
	if (Number.isNaN(n) || h.length !== 6) return null;
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Resolves to whether the palette was applied; `stillCurrent` guards against
// the track changing while the artwork loads.
export async function updateColors(uri: string, stillCurrent: () => boolean): Promise<boolean> {
	let base: Rgb | null = null;
	const url = coverUrl();
	if (url) base = await colourFromImage(url).catch(() => null);
	if (!base && Spicetify.colorExtractor) {
		// Spotify's own extractor is often unavailable, so it's only a fallback.
		const c = await Spicetify.colorExtractor(uri).catch(() => null);
		base = c ? hexToRgb(c.VIBRANT) || hexToRgb(c.PROMINENT) : null;
	}
	if (!stillCurrent()) return false;
	palette = paletteFrom(base || FALLBACK_BASE);
	sweepCache.clear();
	return true;
}

// Used by the progress bar tint and by the page.
export function applyCssVars(host: HTMLElement | null): void {
	if (host) {
		host.style.setProperty("--playerfx-low", rgba(palette.low, 1));
		host.style.setProperty("--playerfx-high", rgba(palette.high, 1));
		host.style.setProperty("--playerfx-glow", rgba(palette.low, 0.5));
		host.classList.toggle("playerfx-tint", settings.mode !== "off" && settings.progressTint);
	}
	const root = document.documentElement.style;
	const accent = palette.accent;
	root.setProperty("--playerfx-accent", rgba(accent, 1));
	// Black text above WCAG's crossover luminance, white below.
	const dark = luminance(accent.map((c) => srgbToLinear(c / 255))) > 0.179;
	root.setProperty("--playerfx-on-accent", dark ? "#000" : "#fff");
}
