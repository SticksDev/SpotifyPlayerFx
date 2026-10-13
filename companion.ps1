# Developer helper for the PlayerFX companion. End users do not need this:
# they download PlayerFxCompanion.exe from the GitHub release, run it once, and
# manage it from the Player FX page inside Spotify.
#
#   .\companion.ps1 build      publish a single-file exe to companion\bin\publish
#   .\companion.ps1 install    build, then run the exe once so it installs itself and starts
#   .\companion.ps1 uninstall  ask the installed copy to remove itself

param(
    [Parameter(Position = 0)][ValidateSet("build", "install", "uninstall", "help")][string]$Command = "help"
)

$ErrorActionPreference = "Stop"
$Src = Join-Path $PSScriptRoot "companion"
$Out = Join-Path $Src "bin\publish"
$Exe = Join-Path $Out "PlayerFxCompanion.exe"
$Installed = Join-Path $env:LOCALAPPDATA "PlayerFX\PlayerFxCompanion.exe"

function Build-Companion {
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw "dotnet SDK not found. Install the .NET 10 SDK." }
    Write-Host "Publishing companion..."
    dotnet publish (Join-Path $Src "PlayerFxCompanion.csproj") -c Release -o $Out --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
    Write-Host "Built $Exe"
}

switch ($Command) {
    "build"     { Build-Companion }
    "install"   { Build-Companion; Start-Process $Exe -ArgumentList "--install"; Write-Host "Installing; a message box confirms when it is running." }
    "uninstall" { if (Test-Path $Installed) { Start-Process $Installed -ArgumentList "--uninstall" } else { Write-Host "Not installed." } }
    default     { Get-Content $PSCommandPath -TotalCount 8 | ForEach-Object { $_ -replace '^#\s?', '' } }
}
