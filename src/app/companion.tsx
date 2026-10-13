// The companion's status and controls, over its local HTTP API (the same
// port as its audio WebSocket).
import type { ReactNode } from "react";
import type { PlayerFxApi } from "../extension/index";
import { t } from "../i18n";
import { h } from "../lib/jsx";
import { SwitchRow } from "./controls";

// Keep in sync with DefaultRepo in companion/Program.cs.
const REPO = "SticksDev/SpotifyPlayerFx";
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const DOWNLOAD_URL = `${RELEASES_URL}/download/PlayerFxCompanion.exe`;

interface Status {
	version: string;
	pid: number;
	uptimeSeconds: number;
	port: number;
	capturing: boolean;
	captureEnabled: boolean;
	spotify: boolean;
	startup: boolean;
	autoGain: boolean;
	installDir: string;
	updateState: string | null;
}

interface UpdateCheck {
	current: string;
	latest?: string;
	available?: boolean;
	error?: string;
}

interface UpdateStart {
	started: boolean;
	latest?: string;
	reason?: string;
	error?: string;
}

async function request<T>(port: number, path: string, { body, timeout = 4000 }: { body?: unknown; timeout?: number } = {}): Promise<T> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeout),
		cache: "no-store",
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
	return (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T;
}

const fetchStatus = (port: number) => request<Status>(port, "/status", { timeout: 1500 }).catch(() => null);

function formatUptime(sec: number): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return t("companion.uptime", { h: Math.floor(sec / 3600), m: pad(Math.floor(sec / 60) % 60), s: pad(sec % 60) });
}

function updateStateText(state: string): string {
	if (state === "downloading") return t("companion.update.downloading");
	if (state === "restarting") return t("companion.update.restarting");
	return t("companion.update.failed", { error: state.replace(/^error: /, "") });
}

const Dot = ({ tone }: { tone?: "on" | "warn" | false }) => <span className={tone ? `pfx-dot ${tone}` : "pfx-dot"} aria-hidden="true" />;

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
	<div className="pfx-field">
		<span className="pfx-field-label">{label}</span>
		<span className="pfx-field-value">{children}</span>
	</div>
);

export function CompanionPanel({ fx }: { fx: PlayerFxApi }) {
	const React = Spicetify.React;
	const port = fx.settings.companionPort;
	// undefined while looking, null when it can't be reached.
	const [status, setStatus] = React.useState<Status | null | undefined>(undefined);
	const [busy, setBusy] = React.useState<string | null>(null);
	const [update, setUpdate] = React.useState<UpdateCheck | null>(null);
	const [logs, setLogs] = React.useState<string | null>(null);
	const [confirming, setConfirming] = React.useState(false);
	const [message, setMessage] = React.useState("");

	// Poll while the page is open; slower when nothing answers.
	React.useEffect(() => {
		let alive = true;
		let timer = 0;
		const poll = async () => {
			const next = await fetchStatus(port);
			if (!alive) return;
			setStatus(next);
			timer = window.setTimeout(poll, next ? 2500 : 10000);
		};
		poll();
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [port]);

	React.useEffect(() => {
		if (!confirming) return;
		const timer = setTimeout(() => setConfirming(false), 4000);
		return () => clearTimeout(timer);
	}, [confirming]);

	const refresh = () => fetchStatus(port).then(setStatus);

	const run = async <T,>(name: string, action: () => Promise<T>, done?: (result: T) => void) => {
		setBusy(name);
		setMessage("");
		try {
			done?.(await action());
		} catch (e) {
			setMessage(t("error.generic", { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			setBusy(null);
			refresh();
		}
	};

	let body: ReactNode;
	if (!status) {
		body = (
			<div>
				<p className="pfx-note">
					<Dot />
					{status === undefined ? t("companion.looking") : <strong>{t("companion.notFound", { port })}</strong>}
				</p>
				<p className="pfx-note">{t("companion.about")}</p>
				<div className="pfx-btns">
					<button type="button" className="pfx-btn primary" onClick={() => window.open(DOWNLOAD_URL, "_blank")}>
						{t("companion.download")}
					</button>
					<button type="button" className="pfx-btn" onClick={() => window.open(RELEASES_URL, "_blank")}>
						{t("companion.releases")}
					</button>
					<button type="button" className="pfx-btn" onClick={refresh}>
						{t("companion.retry")}
					</button>
				</div>
			</div>
		);
	} else {
		const idle = busy === null;
		const live = fx.liveStatus();
		const state = status.capturing ? "capturing" : !status.captureEnabled ? "off" : status.spotify ? "starting" : "waiting";
		body = (
			<div>
				<div className="pfx-fields">
					<Field label={t("companion.field.status")}>
						<Dot tone={status.capturing ? "on" : status.captureEnabled && "warn"} />
						{t(`companion.state.${state}`)}
					</Field>
					<Field label={t("companion.field.version")}>{status.version}</Field>
					<Field label={t("companion.field.uptime")}>{formatUptime(status.uptimeSeconds)}</Field>
					<Field label={t("companion.field.process")}>{t("companion.process", { pid: status.pid, port: status.port })}</Field>
					<Field label={t("companion.field.link")}>
						<Dot tone={live === "live" ? "on" : fx.settings.liveAudio && "warn"} />
						{t(`live.${live}`)}
					</Field>
					<Field label={t("companion.field.installDir")}>
						<span className="pfx-path">{status.installDir}</span>
					</Field>
				</div>
				<SwitchRow
					label={t("companion.capture")}
					hint={t("companion.capture.hint")}
					on={status.captureEnabled}
					disabled={!idle}
					onChange={(enabled) => run("capture", () => request(port, "/capture", { body: { enabled } }))}
				/>
				<SwitchRow
					label={t("companion.startup")}
					hint={t("companion.startup.hint")}
					on={status.startup}
					disabled={!idle}
					onChange={(enabled) => run("startup", () => request(port, "/startup", { body: { enabled } }))}
				/>
				<SwitchRow
					label={t("companion.autoGain")}
					hint={t("companion.autoGain.hint")}
					on={status.autoGain}
					disabled={!idle}
					onChange={(enabled) => run("autogain", () => request(port, "/autogain", { body: { enabled } }))}
				/>
				<div className="pfx-btns">
					<button
						type="button"
						className="pfx-btn"
						disabled={!idle}
						onClick={() => run("check", () => request<UpdateCheck>(port, "/update/check", { timeout: 15000 }), setUpdate)}
					>
						{busy === "check" ? t("companion.checking") : t("companion.checkUpdate")}
					</button>
					{update?.available && (
						<button
							type="button"
							className="pfx-btn primary"
							disabled={!idle}
							onClick={() =>
								run(
									"update",
									() => request<UpdateStart>(port, "/update", { body: {}, timeout: 15000 }),
									(r) =>
										setMessage(
											r.started
												? t("companion.updateStarted", { version: r.latest ?? "" })
												: t("companion.updateSkipped", { reason: r.reason || r.error || t("error.unknown") })
										)
								)
							}
						>
							{t("companion.updateTo", { version: update.latest ?? "" })}
						</button>
					)}
					<button type="button" className="pfx-btn" disabled={!idle} onClick={() => run("logs", () => request<string>(port, "/logs?lines=200"), setLogs)}>
						{logs === null ? t("companion.showLogs") : t("companion.refreshLogs")}
					</button>
					{logs !== null && (
						<button type="button" className="pfx-btn" onClick={() => setLogs(null)}>
							{t("companion.hideLogs")}
						</button>
					)}
					<button
						type="button"
						className="pfx-btn"
						disabled={!idle}
						onClick={() =>
							run("quit", () => request(port, "/quit", { body: {} }), () => {
								setStatus(null);
								setMessage(t("companion.quitDone"));
							})
						}
					>
						{t("companion.quit")}
					</button>
					<button
						type="button"
						className="pfx-btn danger"
						disabled={!idle}
						onClick={() => {
							if (!confirming) {
								setConfirming(true);
								return;
							}
							setConfirming(false);
							run("uninstall", () => request(port, "/uninstall", { body: {} }), () => {
								setStatus(null);
								fx.update({ liveAudio: false });
								setMessage(t("companion.uninstallDone"));
							});
						}}
					>
						{confirming ? t("companion.uninstallConfirm") : t("companion.uninstall")}
					</button>
				</div>
				{update && !update.available && !update.error && <p className="pfx-note">{t("companion.upToDate", { version: update.current })}</p>}
				{update?.error && <p className="pfx-note">{t("companion.updateCheckFailed", { error: update.error })}</p>}
				{status.updateState && <p className="pfx-note">{updateStateText(status.updateState)}</p>}
				{logs !== null && <pre className="pfx-pre">{logs || t("companion.logsEmpty")}</pre>}
			</div>
		);
	}

	return (
		<div className="pfx-card">
			{body}
			<p className="pfx-note pfx-status" role="status">
				{message && <strong>{message}</strong>}
			</p>
		</div>
	);
}
