# Hot-update the INSTALLED app without running the installer.
#
# The installed copy is just Electron + resources/app.asar, so swapping that one
# file is enough for any renderer/main change. Only touch the installer when the
# Electron runtime or a bundled resource (ffmpeg, models) changes.
#
# The real install is C:\Program Files\Video Editor — a per-machine NSIS
# install, confirmed by resolving the actual Desktop shortcut target (it was
# NOT %LOCALAPPDATA%\Programs\Video Editor, which doesn't even exist on this
# machine; this script pointed there for who knows how many builds, so every
# hot-swap silently updated nothing the shortcut ever launched).
#
# Program Files needs admin rights to write to. If this throws access-denied,
# re-run this same command from an elevated PowerShell (right-click PowerShell
# → Run as Administrator).
#
# Usage:  powershell -ExecutionPolicy Bypass -File update-app.ps1

$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'release\win-unpacked\resources\app.asar'
$dstDir = "C:\Program Files\Video Editor\resources"
$dst = Join-Path $dstDir 'app.asar'

if (-not (Test-Path $src)) { throw "Build ausente: $src  (rode: npx electron-builder --dir)" }
if (-not (Test-Path $dstDir)) { throw "App instalado não encontrado em $dstDir" }

# --- Protect the user's project BEFORE touching anything ---------------------
# This script used to Stop-Process -Force the running app. That kills it with no
# chance to flush the autosave, so any edit newer than the last autosave write
# was simply gone — and a project wiped that way has no undo. Never force-kill
# again: ask, wait, and abort rather than risk the work.
$userData = Join-Path $env:APPDATA 'video-editor-app'
$autosave = Join-Path $userData 'autosave.vedit.json'
if (Test-Path $autosave) {
  $stamp  = Get-Date -Format 'yyyy-MM-dd_HHmmss'
  $safeDir = Join-Path $userData 'project-backups'
  New-Item -ItemType Directory -Force $safeDir | Out-Null
  Copy-Item $autosave (Join-Path $safeDir "autosave_$stamp.vedit.json") -Force
  # Keep the 20 most recent; these are small JSON files.
  Get-ChildItem $safeDir -Filter 'autosave_*.vedit.json' |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 | Remove-Item -Force
  Write-Output "backup do projeto salvo em: $safeDir"
}

# The file is locked while the app runs. Ask it to close, then WAIT — if it is
# still up, stop and let the user save, instead of killing their session.
$running = Get-Process 'Video Editor' -ErrorAction SilentlyContinue
if ($running) {
  Write-Output 'Fechando o Video Editor (salve seu projeto se ele perguntar)...'
  $running | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  for ($i = 0; $i -lt 20 -and (Get-Process 'Video Editor' -ErrorAction SilentlyContinue); $i++) {
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process 'Video Editor' -ErrorAction SilentlyContinue) {
    throw "O Video Editor ainda esta aberto. Feche-o manualmente (salvando o projeto) e rode de novo. NAO vou fecha-lo a forca para nao perder edicoes nao salvas."
  }
}

# Keep one rollback copy — a bad asar would otherwise leave no way back.
if (Test-Path $dst) { Copy-Item $dst "$dst.bak" -Force }
Copy-Item $src $dst -Force

$size = [math]::Round((Get-Item $dst).Length / 1MB, 1)
Write-Output "app.asar atualizado ($size MB) em $dstDir"

Start-Process (Join-Path (Split-Path $dstDir) 'Video Editor.exe')
Write-Output 'app reaberto'
