// The canvas behind the now-playing bar, the render loop, and the player
// events that drive it.
import { t } from "../i18n";
import { applyCssVars, updateColors } from "./colors";
import { CYCLE } from "./constants";
import { isLive, restartLive } from "./live";
import { drawMode, resetModes, stepMode } from "./modes";
import { emitChange, saveSettings, settings, type Settings } from "./settings";
import { loadSound, reader } from "./sound";

// Spotify's class names first, its test ids as a fallback for builds that
// renamed them. styles.css also targets the progress bar's classes.
export const SELECTORS = {
	playerBar: [".main-nowPlayingBar-nowPlayingBar", '[data-testid="now-playing-bar"]'],
	nowPlayingWidget: [".main-nowPlayingWidget-nowPlaying", '[data-testid="now-playing-widget"]'],
};

// Clicks inside these keep their own meaning instead of cycling the mode.
const INTERACTIVE = [
	"button",
	"a",
	"input",
	"select",
	"textarea",
	'[role="button"]',
	'[role="slider"]',
	'[role="link"]',
	'[role="switch"]',
	'[role="checkbox"]',
	".playback-bar",
	".x-progressBar-progressBarBg",
	".main-trackInfo-container",
	".main-coverSlotCollapsed-container",
	...SELECTORS.nowPlayingWidget,
].join(", ");

export function findFirst(selectors: string[]): HTMLElement | null {
	for (const selector of selectors) {
		const el = document.querySelector<HTMLElement>(selector);
		if (el) return el;
	}
	return null;
}

export const state = {
	host: null as HTMLElement | null,
	canvas: null as HTMLCanvasElement | null,
	ctx: null as CanvasRenderingContext2D | null,
	resizeObserver: null as ResizeObserver | null,
	width: 0,
	height: 0,
	dpr: 1,
	trackUri: null as string | null,
	raf: 0,
	lastTime: 0,
};

function layout(): void {
	const { host, canvas } = state;
	if (!host || !canvas) return;
	const rect = host.getBoundingClientRect();
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	const w = Math.max(1, Math.round(rect.width));
	const h = Math.max(1, Math.round(rect.height));
	if (w === state.width && h === state.height && dpr === state.dpr) return;
	state.width = w;
	state.height = h;
	state.dpr = dpr;
	canvas.width = Math.round(w * dpr);
	canvas.height = Math.round(h * dpr);
	const ctx = canvas.getContext("2d")!;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	state.ctx = ctx;
}

function currentTrackUri(): string | null {
	const item = Spicetify.Player.data?.item || Spicetify.Player.data?.track;
	return item?.uri || null;
}

function frame(now: number): void {
	state.raf = 0;
	const { ctx, canvas, width, height } = state;
	if (!ctx || !canvas?.isConnected || document.hidden) return;

	const dt = Math.min(0.25, Math.max(0.001, (now - (state.lastTime || now)) / 1000));
	state.lastTime = now;
	syncTrack();

	const mode = settings.mode;
	ctx.clearRect(0, 0, width, height);
	if (mode === "off") return;

	const playing = Spicetify.Player.isPlaying() && !!currentTrackUri();
	const posSec = Spicetify.Player.getProgress() / 1000;
	// Real samples from the companion while they're arriving, otherwise the
	// track's analysis at the playhead.
	const useLive = playing && isLive();
	if (!useLive) reader.read(posSec, playing);

	const moving = stepMode(mode, { dt, now, posSec, playing, useLive, width });
	drawMode(mode, ctx, width, height);
	// Rest once paused and settled; play, track and resize events wake it.
	if (playing || moving) schedule();
}

function schedule(): void {
	if (!state.raf) state.raf = requestAnimationFrame(frame);
}

function wake(): void {
	if (!state.canvas?.isConnected) attach();
	state.lastTime = 0;
	schedule();
}

export function updateSettings(patch: Partial<Settings>): void {
	const before = { ...settings };
	Object.assign(settings, patch);
	saveSettings();
	if (settings.mode !== before.mode) resetModes();
	if (settings.liveAudio !== before.liveAudio || settings.companionPort !== before.companionPort) restartLive();
	applyCssVars(state.host);
	emitChange();
	wake();
}

export function cycleMode(): void {
	const mode = CYCLE[(CYCLE.indexOf(settings.mode) + 1) % CYCLE.length];
	updateSettings({ mode });
	Spicetify.showNotification?.(t("notify.mode", { mode: t(`mode.${mode}`) }));
}

// Empty space in the bar is the visualizer's control, as Winamp's was.
function onHostClick(ev: MouseEvent): void {
	if (!settings.clickCycles || ev.button !== 0) return;
	const target = ev.target;
	if (!(target instanceof Element)) return;
	if (target !== state.host && target.closest(INTERACTIVE)) return;
	cycleMode();
}

function attach(): boolean {
	const host = findFirst(SELECTORS.playerBar);
	if (!host) return false;
	if (state.canvas?.isConnected && state.host === host) return true;

	detach();
	const canvas = document.createElement("canvas");
	canvas.className = "playerfx-canvas";
	host.classList.add("playerfx-host");
	host.prepend(canvas);
	host.addEventListener("click", onHostClick);

	state.host = host;
	state.canvas = canvas;
	state.width = state.height = 0;
	layout();

	state.resizeObserver = new ResizeObserver(() => {
		layout();
		schedule();
	});
	state.resizeObserver.observe(host);
	applyCssVars(host);
	return true;
}

function detach(): void {
	state.resizeObserver?.disconnect();
	state.resizeObserver = null;
	state.canvas?.remove();
	const host = state.host;
	if (host) {
		host.removeEventListener("click", onHostClick);
		host.classList.remove("playerfx-host", "playerfx-tint");
		for (const name of ["low", "high", "glow"]) host.style.removeProperty(`--playerfx-${name}`);
	}
	state.host = null;
	state.canvas = null;
	state.ctx = null;
	cancelAnimationFrame(state.raf);
	state.raf = 0;
}

// Spotify sometimes re-renders the player bar, taking the canvas with it.
export function reattach(): void {
	if (state.canvas?.isConnected && state.host === findFirst(SELECTORS.playerBar)) return;
	if (attach()) schedule();
}

async function onSongChange(): Promise<void> {
	const uri = currentTrackUri();
	if (!uri || uri === state.trackUri) {
		wake();
		return;
	}
	state.trackUri = uri;
	reader.reset();
	const stillCurrent = () => state.trackUri === uri;

	// Colours and sound load independently; whichever lands first applies.
	updateColors(uri, stillCurrent).then((applied) => applied && applyCssVars(state.host));
	const sound = await loadSound(uri, stillCurrent);
	if (!stillCurrent()) return;
	if (sound) {
		reader.analysis = sound.analysis;
		reader.features = sound.features;
	}
	emitChange();
	wake();
}

// The track can change without a songchange reaching us, e.g. a session
// restored at startup before the listener was registered.
function syncTrack(): void {
	const uri = currentTrackUri();
	if (uri && uri !== state.trackUri) onSongChange();
}

export function start(): void {
	Spicetify.Player.addEventListener("songchange", onSongChange);
	Spicetify.Player.addEventListener("onplaypause", wake);
	Spicetify.Player.addEventListener("onprogress", () => {
		syncTrack();
		if (!state.raf) wake();
	});
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) wake();
	});
	attach();
	onSongChange();
}
