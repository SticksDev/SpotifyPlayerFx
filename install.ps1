# Installs (or updates) the built PlayerFX into Spicetify and applies it:
#   dist/playerfx.js   the extension (the visualiser behind the player bar)
#   dist/playerfx/     the custom app (the Player FX page at /playerfx)
#
# Build first with `npm run build` (or use `npm run dist`, which does both).
#
# Usage:  .\install.ps1          copy + register + apply
#         .\install.ps1 -Remove  unregister + delete + apply

param([switch]$Remove)

$ErrorActionPreference = "Stop"
$ext = "playerfx.js"
$app = "playerfx"
$dist = Join-Path $PSScriptRoot "dist"
$extDir = Join-Path $env:APPDATA "spicetify\Extensions"
$appDir = Join-Path $env:APPDATA "spicetify\CustomApps"
$extDst = Join-Path $extDir $ext
$appDst = Join-Path $appDir $app

if ($Remove) {
    spicetify config extensions "$ext-"
    spicetify config custom_apps "$app-"
    if (Test-Path $extDst) { Remove-Item $extDst -Force }
    if (Test-Path $appDst) { Remove-Item $appDst -Recurse -Force }
    Write-Host "Removed $ext and $app"
} else {
    if (-not (Test-Path (Join-Path $dist $ext)) -or -not (Test-Path (Join-Path $dist "$app\index.js"))) {
        throw "dist is missing. Run: npm run build"
    }
    New-Item -ItemType Directory -Force $extDir | Out-Null
    New-Item -ItemType Directory -Force $appDst | Out-Null
    Copy-Item (Join-Path $dist $ext) $extDst -Force
    Copy-Item (Join-Path $dist "$app\*") $appDst -Recurse -Force
    spicetify config extensions $ext
    spicetify config custom_apps $app
    Write-Host "Installed $ext -> $extDst"
    Write-Host "Installed $app -> $appDst"
}

spicetify apply
