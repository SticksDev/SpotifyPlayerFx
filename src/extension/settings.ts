import { DEFAULT_PORT, INTENSITY_LEVELS, MODES, SMOOTHING_LEVELS, isValidPort, type ModeId } from "./constants";

const STORAGE_KEY = "playerfx:settings";

const defaults = {
	mode: "spectrum" as ModeId,
	peakCaps: true,
	bassPulse: true,
	progressTint: true,
	clickCycles: true,
	intensity: 1, // index into INTENSITY_LEVELS
	smoothing: 1, // index into SMOOTHING_LEVELS
	liveAudio: false,
	companionPort: DEFAULT_PORT,
};

export type Settings = typeof defaults;

function load(): Settings {
	let saved: any = null;
	try {
		saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
	} catch {}
	const s: Settings & { enabled?: boolean; bgGlow?: unknown } = { ...defaults, ...saved };
	// Older builds stored an on/off flag instead of a mode.
	if (typeof s.enabled === "boolean" && !saved.mode) s.mode = s.enabled ? "spectrum" : "off";
	delete s.enabled;
	delete s.bgGlow;
	if (!MODES.includes(s.mode)) s.mode = defaults.mode;
	if (!(s.intensity >= 0 && s.intensity < INTENSITY_LEVELS.length)) s.intensity = defaults.intensity;
	if (!(s.smoothing >= 0 && s.smoothing < SMOOTHING_LEVELS.length)) s.smoothing = defaults.smoothing;
	s.companionPort = Number(s.companionPort);
	if (!isValidPort(s.companionPort)) s.companionPort = DEFAULT_PORT;
	return s;
}

export const settings = load();

export function saveSettings(): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

// Fired when settings, the track's data source or the live connection change.
const listeners = new Set<() => void>();

export const onChange = (fn: () => void) => listeners.add(fn);
export const offChange = (fn: () => void) => listeners.delete(fn);

export function emitChange(): void {
	for (const fn of listeners) {
		try {
			fn();
		} catch (e) {
			// A broken listener (say, the page) shouldn't stop the visualizer.
			console.error("[playerfx]", e);
		}
	}
}
