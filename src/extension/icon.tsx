// The (i) next to the song title: shows the mode and what's driving it, and
// opens the Player FX page.
import type { Root } from "react-dom/client";
import { t } from "../i18n";
import { h } from "../lib/jsx";
import { isLive, live } from "./live";
import { SELECTORS, findFirst, state } from "./player";
import { settings } from "./settings";
import { reader } from "./sound";

const PAGE_PATH = "/playerfx";

export function openPage(): void {
	Spicetify.Platform.History?.push(PAGE_PATH);
}

export type SourceId = "off" | "live" | "analysis" | "features" | "none";

// What's driving the visualizer: a short form for the tooltip, a sentence
// for the page.
export function sourceInfo(): { id: SourceId; short: string; text: string } {
	if (settings.mode === "off") return { id: "off", short: "", text: t("source.off") };
	if (isLive() || (settings.liveAudio && live.connected && live.spotify)) {
		return { id: "live", short: t("source.short.live"), text: t("source.live") };
	}
	const id = reader.analysis ? "analysis" : reader.features ? "features" : "none";
	const kind = id === "none" && !state.trackUri ? "idle" : id;
	const short = t(`source.short.${kind}`);
	if (settings.liveAudio) {
		return { id, short: t("source.short.offline", { source: short }), text: t("source.offline") };
	}
	return { id, short, text: t(`source.${kind}`) };
}

function label(): string {
	if (settings.mode === "off") return t("tooltip.off");
	return t("tooltip.on", { mode: t(`mode.${settings.mode}`), source: sourceInfo().short });
}

// Spotify's TooltipWrapper is controlled: it only shows while isOpen is
// true, so hover and focus drive it here with the usual short delay.
function InfoButton() {
	const React = Spicetify.React;
	const [open, setOpen] = React.useState(false);
	const timer = React.useRef(0);
	React.useEffect(() => () => clearTimeout(timer.current), []);

	const show = () => {
		clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setOpen(true), 150);
	};
	const hide = () => {
		clearTimeout(timer.current);
		setOpen(false);
	};
	const text = label();
	const button = (
		<button
			type="button"
			className="playerfx-info"
			data-source={sourceInfo().id}
			aria-label={text}
			onMouseEnter={show}
			onMouseLeave={hide}
			onFocus={show}
			onBlur={hide}
			onClick={(ev) => {
				ev.stopPropagation();
				hide();
				openPage();
			}}
		>
			<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
				<path d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Z" />
				<path d="M7.25 6.5h1.5V12h-1.5V6.5ZM8 3.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
			</svg>
		</button>
	);
	const Tooltip = Spicetify.ReactComponent?.TooltipWrapper;
	if (!Tooltip) return button;
	return (
		<Tooltip label={text} placement="top" isOpen={open} renderInline={false}>
			{button}
		</Tooltip>
	);
}

let slot: HTMLSpanElement | null = null;
let root: Root | null = null;

function render(): void {
	if (!slot) return;
	const { ReactDOM } = Spicetify;
	if (ReactDOM.createRoot) {
		root ??= ReactDOM.createRoot(slot);
		root.render(<InfoButton />);
	} else {
		ReactDOM.render(<InfoButton />, slot);
	}
}

export function updateInfoIcon(): void {
	if (slot?.isConnected) render();
}

export function ensureInfoIcon(): void {
	const widget = findFirst(SELECTORS.nowPlayingWidget);
	if (!widget || slot?.parentElement === widget) return;
	removeInfoIcon();
	slot = document.createElement("span");
	slot.className = "playerfx-info-slot";
	widget.appendChild(slot);
	render();
}

function removeInfoIcon(): void {
	if (root) root.unmount();
	else if (slot) Spicetify.ReactDOM.unmountComponentAtNode(slot);
	root = null;
	slot?.remove();
	slot = null;
}
