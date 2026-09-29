# NexLink one-click launcher (used by the desktop shortcut).
#  1. Makes sure MongoDB is up.
#  2. Starts the control server (hidden) if it is not already running.
#  3. Starts the AI engine (Isolation Forest, hidden) if Python is available.
#  4. Opens the desktop app, and stops whatever this launcher started when the
#     app window is closed.
# Optional: pass -Simulator to also start the demo devices (see docs/DEMO.md).

param([switch]$Simulator)

$ErrorActionPreference = 'Stop'
$root      = $PSScriptRoot
$serverDir = Join-Path $root 'apps\server'
$desktop   = Join-Path $root 'apps\desktop'
$aiDir     = Join-Path $root 'apps\ai-engine'
$agentDir  = Join-Path $root 'apps\agent'
$electron  = Join-Path $root 'node_modules\electron\dist\electron.exe'
$logDir    = Join-Path $env:LOCALAPPDATA 'NEXUS-RMC\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null

Add-Type -AssemblyName System.Windows.Forms
function Fail($msg) {
  [System.Windows.Forms.MessageBox]::Show($msg, 'NexLink', 'OK', 'Error') | Out-Null
  exit 1
}

function Test-Port($port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $port); $true } catch { $false } finally { $c.Close() }
}

# 0. If a previous NexLink window is still running, just bring it forward.
$running = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $electron }
if ($running -and ($running | Where-Object { $_.MainWindowHandle -ne 0 })) {
  Start-Process $electron -ArgumentList "`"$desktop`""   # single-instance: focuses the open window
  exit 0
}
# Leftover invisible processes (e.g. after a crash) would block a new window.
$running | Stop-Process -Force -ErrorAction SilentlyContinue

# 1. MongoDB (installed as the "MongoDB" Windows service, starts automatically)
if (-not (Test-Port 27017)) {
  try { Start-Service MongoDB } catch { }
  for ($i = 0; $i -lt 15 -and -not (Test-Port 27017); $i++) { Start-Sleep 1 }
  if (-not (Test-Port 27017)) {
    Fail "MongoDB is not running on port 27017.`n`nOpen Services (services.msc), start 'MongoDB Server', then try again."
  }
}

# 2. UI build (only needed once, or after the UI source changes)
if (-not (Test-Path (Join-Path $desktop 'dist\index.html'))) {
  Push-Location $root
  npm run build -w @nexus/desktop *> (Join-Path $logDir 'build.log')
  Pop-Location
}

$started = @()

# 3. Control server
if (-not (Test-Port 4000)) {
  $started += Start-Process node -ArgumentList 'src/index.js' -WorkingDirectory $serverDir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'server.err.log')
  for ($i = 0; $i -lt 30 -and -not (Test-Port 4000); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Port 4000)) { Fail "The control server did not start.`n`nSee $logDir\server.err.log" }
}

# 4. AI engine (optional; the server falls back to a simpler detector without it)
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if ($python -and -not (Test-Port 8000)) {
  $started += Start-Process $python -ArgumentList '-m', 'uvicorn', 'engine:app', '--host', '127.0.0.1', '--port', '8000' `
    -WorkingDirectory $aiDir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'ai-engine.log') -RedirectStandardError (Join-Path $logDir 'ai-engine.err.log')
}

# 5. Demo devices (only with -Simulator, after they were enrolled once)
if ($Simulator -and $python) {
  $started += Start-Process $python -ArgumentList '-m', 'nexlink_agent.simulator', '--server', 'http://localhost:4000' `
    -WorkingDirectory $agentDir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'simulator.log') -RedirectStandardError (Join-Path $logDir 'simulator.err.log')
}

# 6. Desktop app (blocks until the window is closed)
if (-not (Test-Path $electron)) { Fail "Electron is missing. Run 'npm install' in $root" }
Start-Process $electron -ArgumentList "`"$desktop`"" -Wait

# 7. Stop what this launcher started
foreach ($p in $started) { if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force } }
