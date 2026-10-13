import { t } from "../i18n";
import { ensureInfoIcon, openPage, sourceInfo, updateInfoIcon } from "./icon";
import { liveStatus, restartLive } from "./live";
import { cycleMode, reattach, start, state, updateSettings } from "./player";
import { offChange, onChange, settings } from "./settings";
import css from "./styles.css";

// What the Player FX page talks to, and a handle for debugging over CDP.
const api = {
	settings,
	update: updateSettings,
	cycleMode,
	sourceInfo,
	liveStatus,
	on: onChange,
	off: offChange,
	state,
};

export type PlayerFxApi = typeof api;

// The audio analysis API isn't required: without it the visualizer falls
// back to audio features.
function ready(): boolean {
	const S = window.Spicetify;
	return !!(S?.Player?.origin && S.Platform && S.Menu && S.React && S.ReactDOM);
}

function main(): void {
	if (!ready()) {
		setTimeout(main, 300);
		return;
	}

	const style = document.createElement("style");
	style.id = "playerfx-style";
	style.textContent = css;
	document.head.appendChild(style);

	start();
	ensureInfoIcon();
	onChange(updateInfoIcon);
	// Spotify sometimes re-renders the player bar. A cheap poll is lighter
	// than observing that whole subtree, which mutates on every progress tick.
	setInterval(() => {
		if (document.hidden) return;
		reattach();
		ensureInfoIcon();
	}, 1500);

	new Spicetify.Menu.Item(t("name"), false, openPage).register();
	window.__playerfx = api;
	restartLive();
}

main();
