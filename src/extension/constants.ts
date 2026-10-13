import type { MessageKey } from "../i18n";

export type ModeId = "off" | "spectrum" | "waveform" | "classic";

export const MODES: ModeId[] = ["off", "spectrum", "waveform", "classic"];
// Clicking the bar steps through these, in Winamp's order.
export const CYCLE: ModeId[] = ["spectrum", "waveform", "classic", "off"];

export const INTENSITY_LEVELS = [
	{ label: "intensity.subtle", strength: 0.7 },
	{ label: "intensity.medium", strength: 1.0 },
	{ label: "intensity.bold", strength: 1.5 },
] satisfies { label: MessageKey; strength: number }[];

// k is how far each band moves toward its new target per frame.
export const SMOOTHING_LEVELS = [
	{ label: "smoothing.off", k: 1 },
	{ label: "smoothing.light", k: 0.55 },
	{ label: "smoothing.smooth", k: 0.3 },
] satisfies { label: MessageKey; k: number }[];

export const DEFAULT_PORT = 47631;
export const isValidPort = (port: number) => Number.isInteger(port) && port >= 1024 && port <= 65535;

export const BANDS = 75;
// Winamp's 75 analyser columns, plus one silent column so the last classic
// bar has a full group of four.
export const CLASSIC_COLUMNS = 75;
// Fifteen of Winamp's 255 band units fill the display.
export const CLASSIC_MAX = 15;
// Winamp's scope reads every seventh sample.
export const SCOPE_STEP = 7;
