# Player FX for Spicetify

Visualizers behind Spotify's now-playing bar, coloured from the current album art. The look and motion follow the player bar and Winamp mini player in [spotifast](https://github.com/crmne/spotifast).

Modes:

- **Spectrum**: 75 semitone bands that jump up with the sound and fall at Winamp's fixed rate, peak caps that hang then drop, a bass pulse along the foot, and a colour sweep from the cover's hue to one a sixth of the way round the wheel.
- **Waveform**: Winamp's scope as a neon line in layers of glow, shaded down to the midline, with a dim mirrored echo.
- **Classic**: Winamp's own 19-bar analyzer in 16 rows with stepped peaks, moving on its own 60 Hz clock.
- **Off**.

Clicking empty space in the player bar cycles Spectrum, Waveform, Classic, Off, as Winamp's visualizer did. Buttons, the progress bar and the track info keep their own clicks. The (i) next to the song title shows which mode is on and what's driving it, and opens the Player FX page.

## Two ways to drive it

**Default: Spotify's analysis of the track.** The Spotify client exposes no PCM audio, so the extension reads Spotify's audio analysis for the track (segment loudness, chroma pitches, timbre and beats) at the current playback position and synthesises the bands and the wave from it. Tracks that have no analysis any more (Spotify has been dropping them since the public API went) fall back to their audio features: a groove from tempo, energy, key and mode. It follows the song closely, but it is an educated guess, not the sound.

**Opt in: live audio from the companion.** A small resident Windows app captures only Spotify's audio through WASAPI process loopback (the same mechanism OBS uses for application audio) and streams a sliding window of mono samples to the extension over a WebSocket on 127.0.0.1. With it connected the extension runs spotifast's actual Winamp analyser: a 512-sample Hann-windowed FFT (two of them half a window apart, averaged), Winamp's 75 semitone band warp, and the scope reading every seventh sample. Nothing is saved but its own settings and log, and nothing leaves the machine except the update check. If it is not running, the extension falls back to the analysis path automatically.

## Install

Requires [Spicetify](https://spicetify.app). Download `playerfx-spicetify.zip` from the [latest release](https://github.com/SticksDev/SpotifyPlayerFx/releases/latest), extract it, and from that folder run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1          # install and spicetify apply
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Remove  # uninstall
```

### From source

Requires Spicetify and Node.js (the sources are TypeScript, bundled with rspack). From this folder:

```powershell
npm install
npm run dist            # build dist/, copy the extension + Player FX page into Spicetify, spicetify apply
.\install.ps1 -Remove   # uninstall
```

After a `git pull`, run `npm run dist` again. `npm run build` only builds; `.\install.ps1` only installs what is in `dist/`.

## The Player FX page

Profile menu (top right avatar) and choose **Player FX**, or click the (i) by the song title. The page is a Spicetify custom app at `/playerfx` with everything in one place:

- Player bar visualizer: Off, Spectrum, Waveform, Classic
- Options: click to cycle, peak caps, bass pulse, progress bar tint, intensity, smoothing
- Live audio: use live audio, companion port
- Companion: download, status, capture on or off, start with Windows, auto gain, check for updates and update, logs, quit, uninstall

Settings persist in localStorage.

## The companion

The page's Companion section has a **Download companion** button that opens the latest GitHub release in your browser. Run the downloaded `PlayerFxCompanion.exe` once: it copies itself to `%LOCALAPPDATA%\PlayerFX`, registers itself to run at sign-in, and starts. From then on it is managed from the page over its local control API. It idles at near zero cost until Spotify is running and capture is on.

Windows 10 2004 or later is needed for process loopback. The exe is self-contained; no .NET install is needed.

Why it has to be resident: Spotify's renderer does not hand custom URL schemes to the OS and a page cannot start a process, so the page can control a running companion but cannot launch a stopped one. If you quit it from the page, it comes back at the next sign-in (if that is on) or by running it from `%LOCALAPPDATA%\PlayerFX`.

Command line (normally not needed): `--resident`, `--install`, `--uninstall`, `--version`, `--port N`, `--no-auto-gain`, `--log PATH`, `--repo OWNER/REPO`. Settings are in `%LOCALAPPDATA%\PlayerFX\settings.json`, logs in `%LOCALAPPDATA%\PlayerFX\logs`.

The API and the WebSocket only answer requests addressed to `127.0.0.1` or `localhost` that come from Spotify's renderer (`https://xpui.app.spotify.com`) or from a local program with no `Origin`, so other websites open in a browser can't control it or listen in. If a Spotify update moves the renderer, add its origin to `allowedOrigins` in `settings.json`.

Control API on `http://127.0.0.1:47631`: `GET /status`, `POST /capture {enabled}`, `POST /startup {enabled}`, `POST /autogain {enabled}`, `GET /logs?lines=N`, `GET /update/check`, `POST /update`, `POST /quit`, `POST /uninstall`. The same port serves the audio WebSocket: a text `hello` frame, `status` frames, and binary frames of 2304 little-endian 16-bit mono samples (the newest 52 ms) at 60 Hz while capturing.

## Releases

The repository is set in two places, `REPO` in `src/app/companion.tsx` and `DefaultRepo` in `companion/Program.cs`; keep them in sync. Push a tag such as `v1.0.0`: the workflow in `.github/workflows/release.yml` typechecks and builds the extension and page into `playerfx-spicetify.zip`, publishes the companion as a single self-contained exe, and attaches both to the release. Bump `version` in `package.json` and `companion/PlayerFxCompanion.csproj` to match. The page's download button and the companion's updater both read the latest release.

## Development

Spicetify's old creator toolchain is deprecated, so this is a plain TypeScript project bundled with [rspack](https://rspack.dev) (`rspack.config.mjs`), two entries:

- `src/extension/` builds to `dist/playerfx.js`, the extension. `index.ts` (boot and the `window.__playerfx` API), `player.ts` (canvas, render loop, player events, `updateSettings`), `modes.ts` (Spectrum, Waveform and Classic: their state, step and drawing), `sound.ts` (analysis and features fetch, band and wave synthesis), `live.ts` (companion WebSocket, Winamp FFT and band warp), `colors.ts` (cover palette and CSS variables), `icon.tsx` (the (i) with Spotify's tooltip), `settings.ts` (storage and the change bus), `constants.ts`.
- `src/app/` builds to `dist/playerfx/`, the Player FX page as a Spicetify custom app: `index.tsx` (the page), `companion.tsx` (companion status, controls and API client), `controls.tsx` (switch, row, segmented buttons), `page.css`, `manifest.json`.
- `src/i18n/`: every string the plugin shows. `en.ts` holds the English text and the keys; `t(key, { name })` fills `{name}` placeholders. The language comes from `Spicetify.Locale` (falling back to the browser's), and any key a language leaves out falls back to English. To add a language, create `src/i18n/<lang>.ts` exporting `Messages` and register it in `src/i18n/index.ts`. Keys are typed, so a missing or misspelled key fails the typecheck.
- JSX compiles to `h()` from `src/lib/jsx.ts`, a thin wrapper over Spotify's own React (`Spicetify.React`), so no React is bundled. CSS files are imported as strings and injected at runtime. Types for the Spicetify global live in `src/types/`. The page's colours come from Spicetify's `--spice-*` theme variables, so it follows the installed theme.

Scripts: `npm run build`, `npm run watch`, `npm run typecheck`, `npm run install:spicetify`, `npm run dist` (build + install).

- `companion/`: the companion (C#, .NET 10 SDK to build): `Program.cs` (command line, install, settings, log), `Capture.cs`, `Server.cs` (HTTP API and WebSocket), `Updater.cs`. `.\companion.ps1 build` publishes a single-file exe to `companion\bin\publish`; `.\companion.ps1 install` builds and runs the self-install; `.\companion.ps1 uninstall` asks the installed copy to remove itself.
- `tools/cdp.ps1`: evaluate JavaScript in the running Spotify renderer (launch Spotify with `--remote-debugging-port=9222`). `-Hover <selector>` moves a trusted mouse onto an element first, which Spotify's tooltips need. `window.__playerfx` exposes `settings`, `update(patch)`, `cycleMode`, `sourceInfo`, `liveStatus`, the render `state`, and `on`/`off` for change events.

## License

MIT, see [LICENSE](LICENSE).
