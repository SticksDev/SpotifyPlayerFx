# Player FX for Spicetify

Bring classic Winamp-style visualizers to Spotify. Player FX adds animated effects behind the playback bar, with colors that match your current album art.

Inspired by [spotifast](https://github.com/crmne/spotifast).

## Features

- **Spectrum:** 75 animated frequency bands with falling peaks and a bass pulse.
- **Waveform:** A glowing, animated waveform with a mirrored reflection.
- **Classic:** Winamp's original 19-bar visualizer with stepped peaks.
- **Customizable:** Adjust intensity, smoothing, peak caps, and bass pulse.
- **Live audio:** Optional Windows companion for visualizations driven by actual Spotify audio.
- **Theme support:** Works with Spicetify themes and adapts to album artwork.

Click an empty area of Spotify's playback bar to switch between Spectrum, Waveform, Classic, and Off.

## Installation

You'll need [Spicetify](https://spicetify.app) installed first.

1. Download `playerfx-spicetify.zip` from the [latest release](https://github.com/SticksDev/SpotifyPlayerFx/releases/latest).
2. Extract the ZIP file.
3. Open PowerShell in the extracted folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

To uninstall:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Remove
```

## Live Audio (Optional)

By default, Player FX uses Spotify's track analysis to approximate the music. This works without any additional software, but the visualizer won't perfectly match what you're hearing.

For accurate, real-time visualizations, you can install the optional Windows companion.

1. Open **Player FX** from your Spotify profile menu.
2. Find the **Companion** section and click **Download companion**.
3. Run `PlayerFxCompanion.exe` to install it.
4. Enable **Live Audio** in Player FX settings.

The companion captures only Spotify's audio and sends it locally to the extension. Audio is never recorded or uploaded.

**Requirements:** Windows 10 version 2004 or newer. No separate .NET installation is required.

If the companion isn't running, Player FX automatically falls back to Spotify's track analysis.

## Settings

Open **Player FX** from Spotify's profile menu, or click the info icon next to the song title.

You can change visualizer modes, adjust intensity and smoothing, toggle peak effects, and manage the Windows companion.

Settings are saved automatically.

## Building From Source

Requires Node.js and Spicetify.

```powershell
npm install
npm run dist
```

This builds and installs Player FX into Spicetify.

## Credits

Inspired by [spotifast](https://github.com/crmne/spotifast) and the original Winamp visualizers.

## License

MIT. See [LICENSE](LICENSE).