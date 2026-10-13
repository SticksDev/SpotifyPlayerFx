// The Player FX page, a Spicetify custom app at /playerfx. Settings go through
// the extension's window.__playerfx so both stay in step.
import { DEFAULT_PORT, INTENSITY_LEVELS, MODES, SMOOTHING_LEVELS, isValidPort } from "../extension/constants";
import { t } from "../i18n";
import { h } from "../lib/jsx";
import { CompanionPanel } from "./companion";
import { Row, Segmented, SwitchRow } from "./controls";
import css from "./page.css";

// Injected on load rather than on mount, so the first render is styled.
if (!document.getElementById("playerfx-page-style")) {
	const style = document.createElement("style");
	style.id = "playerfx-page-style";
	style.textContent = css;
	document.head.appendChild(style);
}

function Page() {
	const React = Spicetify.React;
	const fx = window.__playerfx;
	const [, rerender] = React.useReducer((n: number) => n + 1, 0);

	React.useEffect(() => {
		if (!fx) return;
		fx.on(rerender);
		return () => {
			fx.off(rerender);
		};
	}, [fx]);

	if (!fx) {
		return (
			<div className="pfx">
				<h1>{t("name")}</h1>
				<p className="pfx-sub">{t("page.missing")}</p>
			</div>
		);
	}

	const s = fx.settings;
	const [footBefore, footAfter] = t("page.foot").split("{link}");

	return (
		<div className="pfx">
			<h1>{t("name")}</h1>
			<p className="pfx-sub">{fx.sourceInfo().text}</p>

			<section className="pfx-section">
				<h2>{t("page.modes.title")}</h2>
				<p className="pfx-hint">{t("page.modes.hint")}</p>
				<div className="pfx-modes" role="group" aria-label={t("page.modes.title")}>
					{MODES.map((id) => (
						<button key={id} type="button" className="pfx-mode" aria-pressed={s.mode === id} onClick={() => fx.update({ mode: id })}>
							<span className="pfx-mode-name">{t(`mode.${id}`)}</span>
							<span className="pfx-mode-blurb">{t(`mode.${id}.blurb`)}</span>
						</button>
					))}
				</div>
			</section>

			<section className="pfx-section">
				<h2>{t("page.options.title")}</h2>
				<div className="pfx-card">
					<SwitchRow
						label={t("page.options.clickCycles")}
						hint={t("page.options.clickCycles.hint")}
						on={s.clickCycles}
						onChange={(v) => fx.update({ clickCycles: v })}
					/>
					<SwitchRow label={t("page.options.peakCaps")} hint={t("page.options.peakCaps.hint")} on={s.peakCaps} onChange={(v) => fx.update({ peakCaps: v })} />
					<SwitchRow label={t("page.options.bassPulse")} hint={t("page.options.bassPulse.hint")} on={s.bassPulse} onChange={(v) => fx.update({ bassPulse: v })} />
					<SwitchRow
						label={t("page.options.progressTint")}
						hint={t("page.options.progressTint.hint")}
						on={s.progressTint}
						onChange={(v) => fx.update({ progressTint: v })}
					/>
					<Row label={t("page.options.intensity")} hint={t("page.options.intensity.hint")}>
						<Segmented
							label={t("page.options.intensity")}
							options={INTENSITY_LEVELS.map((level) => t(level.label))}
							value={s.intensity}
							onChange={(i) => fx.update({ intensity: i })}
						/>
					</Row>
					<Row label={t("page.options.smoothing")} hint={t("page.options.smoothing.hint")}>
						<Segmented
							label={t("page.options.smoothing")}
							options={SMOOTHING_LEVELS.map((level) => t(level.label))}
							value={s.smoothing}
							onChange={(i) => fx.update({ smoothing: i })}
						/>
					</Row>
				</div>
			</section>

			<section className="pfx-section">
				<h2>{t("page.live.title")}</h2>
				<p className="pfx-hint">{t("page.live.hint")}</p>
				<div className="pfx-card">
					<SwitchRow
						label={t("page.live.toggle")}
						hint={t("page.live.status", { status: t(`live.${fx.liveStatus()}`) })}
						on={s.liveAudio}
						onChange={(v) => fx.update({ liveAudio: v })}
					/>
					<Row label={t("page.live.port")} hint={t("page.live.port.hint", { port: DEFAULT_PORT })}>
						<input
							className="pfx-input"
							type="number"
							min={1024}
							max={65535}
							defaultValue={s.companionPort}
							aria-label={t("page.live.port")}
							onKeyDown={(ev) => ev.key === "Enter" && ev.currentTarget.blur()}
							onBlur={(ev) => {
								const port = Number(ev.currentTarget.value);
								if (!isValidPort(port)) ev.currentTarget.value = String(s.companionPort);
								else if (port !== s.companionPort) fx.update({ companionPort: port });
							}}
						/>
					</Row>
				</div>
			</section>

			<section className="pfx-section">
				<h2>{t("companion.title")}</h2>
				<CompanionPanel fx={fx} />
			</section>

			<p className="pfx-foot">
				{footBefore}
				<a href="https://github.com/crmne/spotifast" target="_blank" rel="noopener">
					spotifast
				</a>
				{footAfter}
			</p>
		</div>
	);
}

// Spicetify mounts a custom app by calling the global render().
window.render = () => Spicetify.React.createElement(Page);
