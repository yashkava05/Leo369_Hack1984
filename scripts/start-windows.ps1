<#
.SYNOPSIS
  Latent on Windows: check, set up and start the whole app with one command.

.DESCRIPTION
  The Windows counterpart of scripts/setup.sh + scripts/dev.sh, for the demo laptop. It:
    1. checks the prerequisites (Python 3.11+, Node 20.19+, Ollama 0.7+ installed and running,
       the vision model pulled, the spaCy model, the optional voice model) and prints a fix for
       each one that is missing;
    2. creates .env from .env.example if there is none (an existing .env or .env.local is never
       touched, and key values are never printed);
    3. creates or refreshes backend\.venv and frontend\node_modules, only when they are missing or
       pyproject.toml / package-lock.json changed since the last install;
    4. starts Ollama if it is not answering (it keeps running afterwards, like dev.sh), then the
       backend on :8000, waits for /api/health, starts the frontend on :5173 and opens the chat;
    5. stops the backend and the frontend when you press Ctrl+C or close the window.

  Double-click scripts\start-windows.cmd, or from PowerShell in the repo:
    powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1 [flags]

  Clone the repo onto the Windows drive (for example C:\src\latent). A checkout on the WSL file
  system (\\wsl.localhost\...) shares backend\.venv and node_modules with Linux and will not work.

.PARAMETER Check
  Dry run: only report readiness. Installs nothing, starts nothing, writes nothing.
  Exits 0 when ready, 1 when something must be fixed.

.PARAMETER Mock
  LATENT_MOCK=1: the backend replays recorded fixtures. No Ollama and no network needed.

.PARAMETER AirGap
  LATENT_OFFLINE=1: the backend starts with air-gap on, so every outbound request is blocked.
  Extraction still runs on the local model. The Air-gap switch in the UI can turn it off.

.PARAMETER Wsl
  Bind the backend and the frontend to 0.0.0.0 (instead of 127.0.0.1) and, if this script starts
  Ollama, bind Ollama to 0.0.0.0 too, so all three are reachable from WSL. This also makes them
  reachable from the local network: do not use it on venue Wi-Fi unless you need it.

.PARAMETER Reinstall
  Re-run pip install and npm ci even when nothing changed.

.PARAMETER NoBrowser
  Do not open the chat page in the browser.

.EXAMPLE
  scripts\start-windows.ps1 -Check
.EXAMPLE
  scripts\start-windows.ps1 -Mock
.EXAMPLE
  scripts\start-windows.ps1 -AirGap -Wsl
#>
param(
  [switch]$Check,
  [switch]$Mock,
  [switch]$AirGap,
  [switch]$Wsl,
  [switch]$Reinstall,
  [switch]$NoBrowser
)

# Also accept GNU-style flags (--check, --mock, --air-gap, --wsl, --reinstall, --no-browser).
foreach ($a in $args) {
  switch -Regex ("$a".ToLowerInvariant()) {
    '^--check$'       { $Check = $true; continue }
    '^--mock$'        { $Mock = $true; continue }
    '^--air-?gap$'    { $AirGap = $true; continue }
    '^--wsl$'         { $Wsl = $true; continue }
    '^--reinstall$'   { $Reinstall = $true; continue }
    '^--no-?browser$' { $NoBrowser = $true; continue }
    default { Write-Host "error: unknown argument '$a'. See: Get-Help scripts\start-windows.ps1 -Detailed"; exit 2 }
  }
}

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 1.0
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root 'backend'
$Frontend = Join-Path $Root 'frontend'
$Venv = Join-Path $Backend '.venv'
$VenvPy = Join-Path $Venv 'Scripts\python.exe'
$BackendPort = 8000
$FrontendPort = 5173
$MinOllama = [version]'0.7.0'
$MinNode = [version]'20.19.0'
$BindHost = if ($Wsl) { '0.0.0.0' } else { '127.0.0.1' }

$script:Failures = 0
$script:Warnings = 0

function Step([string]$m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host "  [ ok ] $m" -ForegroundColor Green }
function Info([string]$m) { Write-Host "         $m" }
function Warn([string]$m, [string]$fix = '') {
  $script:Warnings++
  Write-Host "  [warn] $m" -ForegroundColor Yellow
  if ($fix) { Write-Host "         fix: $fix" -ForegroundColor Yellow }
}
function Fail([string]$m, [string]$fix) {
  $script:Failures++
  Write-Host "  [FAIL] $m" -ForegroundColor Red
  Write-Host "         fix: $fix" -ForegroundColor Red
}
function Die([string]$m) { Write-Host ""; Write-Host "error: $m" -ForegroundColor Red; exit 1 }

# Run a native command and capture stdout without letting stderr become a terminating error
# (Windows PowerShell 5.1 turns redirected native stderr into errors under 'Stop').
function Run([string]$exe, [string[]]$argv) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $exe @argv 2>$null
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = (($out | ForEach-Object { "$_" }) -join "`n").Trim() }
  } catch {
    return [pscustomobject]@{ Code = 1; Out = '' }
  } finally {
    $ErrorActionPreference = $old
  }
}

# Run a native command with its output on the console; die if it fails.
function RunOrDie([string]$exe, [string[]]$argv, [string]$what) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { Die "$what failed (exit $LASTEXITCODE); see the output above" }
}

# Read KEY the way the backend does (backend/app/config.py): .env, backend\.env, .env.local,
# backend\.env.local (later wins); the process environment wins over all of them. Values are only returned, never printed.
function Get-Setting([string]$key, [string]$default = '') {
  $fromEnv = [Environment]::GetEnvironmentVariable($key)
  if ($fromEnv) { return $fromEnv }
  $value = ''
  foreach ($name in '.env', 'backend\.env', '.env.local', 'backend\.env.local') {
    $file = Join-Path $Root $name
    if (-not (Test-Path -LiteralPath $file)) { continue }
    foreach ($line in Get-Content -LiteralPath $file) {
      if ($line -match "^\s*$([regex]::Escape($key))\s*=(.*)$") {
        $value = $Matches[1].Trim().Trim('"').Trim("'")
      }
    }
  }
  if ($value) { return $value }
  return $default
}

function Get-Http([string]$url, [int]$timeout = 2) {
  try { return Invoke-RestMethod -Uri $url -TimeoutSec $timeout -UseBasicParsing } catch { return $null }
}

function Test-PortListening([int]$port) {
  try {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)
  } catch {
    return $false
  }
}

function Get-FileSha([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return 'missing' }
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
}

function Find-Python {
  # Prefer the py launcher's 3.11 / 3.12 (what the pinned spaCy model is built for), then python.
  $candidates = @()
  if ($env:PYTHON) { $candidates += , @($env:PYTHON) }
  if (Get-Command py.exe -ErrorAction SilentlyContinue) {
    $candidates += , @('py.exe', '-3.11')
    $candidates += , @('py.exe', '-3.12')
    $candidates += , @('py.exe', '-3')
  }
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  # Skip the Microsoft Store stub in WindowsApps: it opens the Store instead of running Python.
  if ($python -and $python.Source -notmatch '\\WindowsApps\\') { $candidates += , @($python.Source) }
  foreach ($c in $candidates) {
    $exe = $c[0]
    $pre = @(); if ($c.Count -gt 1) { $pre = @($c[1..($c.Count - 1)]) }
    $r = Run $exe ($pre + @('-c', 'import sys; print(sys.version_info[0]*100+sys.version_info[1])'))
    if ($r.Code -eq 0 -and $r.Out -match '^\d+$' -and [int]$r.Out -ge 311) {
      return [pscustomobject]@{ Exe = $exe; Pre = $pre; Version = ('{0}.{1}' -f [math]::Floor([int]$r.Out / 100), ([int]$r.Out % 100)) }
    }
  }
  return $null
}

function Find-Ollama {
  $cmd = Get-Command ollama.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $default = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
  if ($env:LOCALAPPDATA -and (Test-Path -LiteralPath $default)) { return $default }
  return $null
}

# --- Settings ---------------------------------------------------------------------------------
$OllamaHost = Get-Setting 'OLLAMA_HOST' 'http://localhost:11434'
if ($OllamaHost -notmatch '://') { $OllamaHost = "http://$OllamaHost" }
$OllamaHost = $OllamaHost.TrimEnd('/')
# A server-side bind address such as 0.0.0.0 is not something a client can connect to.
# Use 127.0.0.1 rather than localhost so Windows does not try ::1 first.
$OllamaUrl = $OllamaHost -replace '://(0\.0\.0\.0|localhost)(?=[:/]|$)', '://127.0.0.1'
$Model = Get-Setting 'LATENT_MODEL' 'qwen2.5vl:3b'
if (-not $Mock -and (Get-Setting 'LATENT_MOCK' '0') -match '^(1|true|yes|on)$') {
  $Mock = $true
  $mockSource = ' (LATENT_MOCK is set in .env / the environment)'
} else {
  $mockSource = ''
}

$mode = if ($Check) { 'readiness check (dry run, nothing is changed)' } else { 'setup + start' }
Write-Host "Latent on Windows: $mode"
Write-Host "repo: $Root"
if ($Mock) { Write-Host "mock mode: the backend replays fixtures; Ollama is not needed$mockSource" }
if ($AirGap) { Write-Host "air-gap: the backend starts with every outbound request blocked (LATENT_OFFLINE=1)" }
if ($Wsl) { Write-Host "WSL mode: binding the backend and frontend to 0.0.0.0" }

# --- 1. Prerequisites -------------------------------------------------------------------------
Step 'Checking prerequisites'

if ($Root -match '^(Microsoft\.PowerShell\.Core\\FileSystem::)?\\\\') {
  Fail "the repo is on a network / WSL path ($Root)" `
    'clone it onto the Windows drive instead, e.g. git clone https://github.com/yashkava05/Leo369_Hack1984.git C:\src\latent'
} else {
  Ok 'repo is on a local Windows drive'
}

$Py = Find-Python
if ($Py) {
  Ok "Python $($Py.Version) ($($Py.Exe) $($Py.Pre -join ' '))"
} else {
  Fail 'Python 3.11+ not found' 'install Python 3.11 from https://www.python.org/downloads/windows/ (tick "Add python.exe to PATH"), then open a new terminal'
}

$NodeOk = $false
if (Get-Command node.exe -ErrorAction SilentlyContinue) {
  $r = Run 'node.exe' @('--version')
  $nodeVersion = $null
  if ($r.Out -match '(\d+\.\d+\.\d+)') { $nodeVersion = [version]$Matches[1] }
  if ($nodeVersion -and $nodeVersion -ge $MinNode) {
    Ok "Node $nodeVersion"
    $NodeOk = $true
  } else {
    Fail "Node $($r.Out) is too old (Vite needs $MinNode+)" 'install the Node LTS from https://nodejs.org/ and open a new terminal'
  }
} else {
  Fail 'Node.js not found' 'install the Node LTS (20.19+) from https://nodejs.org/ and open a new terminal'
}
$Npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($NodeOk -and -not $Npm) { Fail 'npm not found' 'reinstall Node from https://nodejs.org/ (npm ships with it)' }

$OllamaExe = Find-Ollama
$OllamaUp = $false
if ($Mock) {
  Info 'Ollama: not needed in mock mode (skipped)'
} else {
  if ($OllamaExe) {
    $r = Run $OllamaExe @('--version')
    $ollamaVersion = $null
    if ($r.Out -match '(\d+\.\d+(\.\d+)?)') { $ollamaVersion = [version]$Matches[1] }
    if ($ollamaVersion -and $ollamaVersion -ge $MinOllama) {
      Ok "Ollama $ollamaVersion installed"
    } elseif ($ollamaVersion) {
      Fail "Ollama $ollamaVersion is too old (qwen2.5vl needs $MinOllama+)" 'update it from https://ollama.com/download/windows'
    } else {
      Warn "could not read the Ollama version from '$OllamaExe --version'"
    }
  } elseif (Get-Http "$OllamaUrl/api/version") {
    Warn "ollama.exe not found on PATH or in %LOCALAPPDATA%\Programs\Ollama, but a server answers at $OllamaUrl" `
      'add the Ollama folder to PATH so this script can pull the model if needed'
  } else {
    Fail 'Ollama not installed' 'install it from https://ollama.com/download/windows, then re-run this script'
  }

  $OllamaUp = [bool](Get-Http "$OllamaUrl/api/version")
  if ($OllamaUp) {
    Ok "Ollama is running at $OllamaUrl"
    if ($Wsl) {
      $listen = @()
      try { $listen = @(Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction Stop | ForEach-Object { $_.LocalAddress }) } catch { }
      if ($listen.Count -gt 0 -and -not ($listen -contains '0.0.0.0' -or $listen -contains '::')) {
        Warn "Ollama listens on $($listen -join ', ') only, so WSL cannot reach it" `
          'quit Ollama from the tray, run: setx OLLAMA_HOST 0.0.0.0:11434 , then start Ollama again'
      }
    }
  } elseif ($Check) {
    Fail "Ollama is not answering at $OllamaUrl" 'start the Ollama app from the Start menu (or run: ollama serve); without -Check this script starts it'
  } else {
    Info "Ollama is not answering at $OllamaUrl yet; it will be started below"
  }

  if ($OllamaUp) {
    $tags = Get-Http "$OllamaUrl/api/tags" 5
    $names = @()
    if ($tags -and $tags.models) { $names = @($tags.models | ForEach-Object { $_.name; $_.model }) }
    if ($names -contains $Model) {
      Ok "model $Model is pulled"
    } elseif ($Check) {
      Fail "model $Model is not pulled" "run: ollama pull $Model   (about 3.2 GB; without -Check this script pulls it)"
    } else {
      Info "model $Model is not pulled yet; it will be pulled below"
    }
  }
}

# Backend environment: venv, deps, spaCy model, optional voice model.
$VenvState = 'missing'
if (Test-Path -LiteralPath $VenvPy) {
  $VenvState = 'present'
} elseif (Test-Path -LiteralPath $Venv) {
  $VenvState = 'foreign'
  Fail 'backend\.venv exists but has no Scripts\python.exe (it was probably created by Linux/WSL)' `
    'delete the backend\.venv folder (or use a separate Windows clone), then re-run this script'
}
$PyStamp = Get-FileSha (Join-Path $Backend 'pyproject.toml')
$NpmStamp = Get-FileSha (Join-Path $Frontend 'package-lock.json')
$PyStampFile = Join-Path $Venv '.latent-install-stamp'
$NpmStampFile = Join-Path $Frontend 'node_modules\.latent-install-stamp'

function Test-BackendDeps { (Run $VenvPy @('-c', 'import uvicorn, fastapi, presidio_analyzer')).Code -eq 0 }
function Test-Spacy { (Run $VenvPy @('-c', 'import en_core_web_lg')).Code -eq 0 }
function Read-Stamp([string]$file) { if (Test-Path -LiteralPath $file) { return (Get-Content -LiteralPath $file -Raw).Trim() } return '' }

if ($VenvState -eq 'present') {
  if (Test-BackendDeps) {
    if ((Read-Stamp $PyStampFile) -eq $PyStamp) { Ok 'backend\.venv has the backend dependencies' }
    else { Ok 'backend\.venv has the backend dependencies'; Info 'pyproject.toml changed since the last install here; it will be refreshed' }
  } else {
    if ($Check) { Fail 'backend dependencies are not installed in backend\.venv' 'run this script without -Check' }
    else { Info 'backend dependencies are missing; they will be installed below' }
  }
  if (Test-Spacy) { Ok 'spaCy model en_core_web_lg (PII scrubber) imports' }
  elseif ($Check) { Fail 'spaCy model en_core_web_lg is missing' 'run this script without -Check (it is pinned in backend\pyproject.toml)' }
} elseif ($VenvState -eq 'missing') {
  if ($Check) { Fail 'backend\.venv does not exist (backend deps and the spaCy model are not installed)' 'run this script without -Check' }
  else { Info 'backend\.venv does not exist yet; it will be created below' }
}

$NodeModules = Join-Path $Frontend 'node_modules'
$ViteJs = Join-Path $Frontend 'node_modules\vite\bin\vite.js'
if (Test-Path -LiteralPath $ViteJs) {
  Ok 'frontend\node_modules is installed'
  if ((Read-Stamp $NpmStampFile) -ne $NpmStamp) { Info 'package-lock.json changed since the last install here (or it was installed outside this script); it will be refreshed' }
} elseif ($Check) {
  Fail 'frontend dependencies are not installed' 'run this script without -Check (or: cd frontend; npm ci)'
} else {
  Info 'frontend dependencies are missing; they will be installed below'
}

# Optional local voice model (faster-whisper, see scripts/setup_voice.sh when it lands).
$SttPath = Get-Setting 'LATENT_STT_MODEL_PATH' '~/.latent/models/faster-whisper-base.en'
$SttPath = $SttPath -replace '^~', $HOME
if (Test-Path -LiteralPath $SttPath) {
  if ($VenvState -eq 'present' -and (Run $VenvPy @('-c', 'import faster_whisper')).Code -eq 0) { Ok "optional voice model found ($SttPath)" }
  else { Warn 'optional voice model is downloaded but faster-whisper is not installed in backend\.venv' 'only needed for voice input: install the backend voice extra (pip install -e ".[voice]" in backend, see scripts/setup_voice.sh once local voice lands)' }
} else {
  Info "optional voice model not found ($SttPath); voice input will offer typed text instead"
}

# .env and keys: report presence only, never values.
if (Test-Path -LiteralPath (Join-Path $Root '.env')) { Ok '.env exists (left as is)' }
elseif ($Check) { Info '.env does not exist; without -Check it is created from .env.example' }
if (Test-Path -LiteralPath (Join-Path $Root '.env.local')) { Ok '.env.local exists (left as is)' }
foreach ($key in 'TAVILY_API_KEY', 'EXA_API_KEY') {
  if (Get-Setting $key) { Ok "$key is set" }
  elseif ($key -eq 'TAVILY_API_KEY' -and -not $Mock -and -not $AirGap) {
    Warn 'TAVILY_API_KEY is not set: web searches will fail' 'put TAVILY_API_KEY=... in .env.local at the repo root (never commit it)'
  } else { Info "$key is not set (optional here)" }
}

foreach ($port in $BackendPort, $FrontendPort) {
  if (Test-PortListening $port) { Fail "port $port is already in use" "stop whatever is using it (another Latent running? check: Get-NetTCPConnection -LocalPort $port -State Listen)" }
  else { Ok "port $port is free" }
}

if ($Check) {
  Write-Host ""
  if ($script:Failures -eq 0) {
    Write-Host "Ready ($script:Warnings warning(s)). Start it with: scripts\start-windows.cmd" -ForegroundColor Green
    exit 0
  }
  Write-Host "Not ready: $script:Failures problem(s) to fix, $script:Warnings warning(s). See the 'fix:' lines above." -ForegroundColor Red
  exit 1
}

# Problems that setup below cannot repair.
if ($script:Failures -gt 0) { Die "fix the $script:Failures problem(s) above, then re-run this script" }

# --- 2. Setup ---------------------------------------------------------------------------------
Step 'Setting up'

$EnvFile = Join-Path $Root '.env'
$EnvExample = Join-Path $Root '.env.example'
if (-not (Test-Path -LiteralPath $EnvFile) -and (Test-Path -LiteralPath $EnvExample)) {
  Copy-Item -LiteralPath $EnvExample -Destination $EnvFile
  Ok 'created .env from .env.example (put your keys in .env.local)'
}

if (-not $Mock) {
  if (-not $OllamaUp) {
    $log = Join-Path $env:TEMP 'latent-ollama-serve.log'
    Info "starting 'ollama serve' in the background; it keeps running after this script exits (log: $log)"
    $savedHost = $env:OLLAMA_HOST
    $env:OLLAMA_HOST = if ($Wsl) { '0.0.0.0:11434' } else { $OllamaUrl }
    try {
      Start-Process -FilePath $OllamaExe -ArgumentList 'serve' -WindowStyle Hidden -RedirectStandardError $log | Out-Null
    } finally {
      $env:OLLAMA_HOST = $savedHost
    }
    for ($i = 0; $i -lt 20 -and -not $OllamaUp; $i++) { Start-Sleep -Seconds 1; $OllamaUp = [bool](Get-Http "$OllamaUrl/api/version") }
    if ($OllamaUp) { Ok "Ollama started at $OllamaUrl" }
    else { Warn "Ollama did not answer within 20 s (see $log)" 'start the Ollama app from the Start menu; the UI will show a banner until it answers' }
  }
  if ($OllamaUp) {
    $tags = Get-Http "$OllamaUrl/api/tags" 5
    $names = @()
    if ($tags -and $tags.models) { $names = @($tags.models | ForEach-Object { $_.name; $_.model }) }
    if (-not ($names -contains $Model)) {
      if (-not $OllamaExe) { Die "model $Model is not pulled and ollama.exe was not found; run: ollama pull $Model" }
      Info "pulling $Model (about 3.2 GB for qwen2.5vl:3b)"
      $savedHost = $env:OLLAMA_HOST
      $env:OLLAMA_HOST = $OllamaUrl
      try { RunOrDie $OllamaExe @('pull', $Model) "ollama pull $Model" } finally { $env:OLLAMA_HOST = $savedHost }
      Ok "model $Model pulled"
    }
  }
}

if ($VenvState -eq 'missing') {
  Info 'creating backend\.venv'
  RunOrDie $Py.Exe ($Py.Pre + @('-m', 'venv', $Venv)) 'creating backend\.venv'
}
if ($Reinstall -or (Read-Stamp $PyStampFile) -ne $PyStamp -or -not (Test-BackendDeps) -or -not (Test-Spacy)) {
  Info 'installing backend dependencies into backend\.venv (the first run downloads the ~600 MB spaCy model)'
  RunOrDie $VenvPy @('-m', 'pip', 'install', '--quiet', '--upgrade', 'pip') 'upgrading pip'
  Push-Location $Backend
  try { RunOrDie $VenvPy @('-m', 'pip', 'install', '--quiet', '-e', '.[dev]') 'pip install -e .[dev]' } finally { Pop-Location }
  if (-not (Test-Spacy)) { Die 'en_core_web_lg does not import after the backend install; check the pip output above' }
  Set-Content -LiteralPath $PyStampFile -Value $PyStamp -Encoding ASCII
  Ok 'backend dependencies installed'
} else {
  Ok 'backend dependencies up to date'
}

if ($Reinstall -or -not (Test-Path -LiteralPath $ViteJs) -or (Read-Stamp $NpmStampFile) -ne $NpmStamp) {
  # npm ci installs exactly what package-lock.json pins and never rewrites it.
  $npmCmd = if (Test-Path -LiteralPath (Join-Path $Frontend 'package-lock.json')) { 'ci' } else { 'install' }
  Info "installing frontend dependencies (npm $npmCmd)"
  Push-Location $Frontend
  try { RunOrDie $Npm.Source @($npmCmd, '--no-fund', '--no-audit') "npm $npmCmd" } finally { Pop-Location }
  if (-not (Test-Path -LiteralPath $ViteJs)) { Die 'vite is missing after the npm install; check the npm output above' }
  Set-Content -LiteralPath $NpmStampFile -Value (Get-FileSha (Join-Path $Frontend 'package-lock.json')) -Encoding ASCII
  Ok 'frontend dependencies installed'
} else {
  Ok 'frontend dependencies up to date'
}

# --- 3. Start ---------------------------------------------------------------------------------
Step 'Starting Latent'

$procs = @()
$savedEnv = @{}
function Set-ChildEnv([string]$name, [string]$value) {
  if (-not $savedEnv.ContainsKey($name)) { $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name) }
  [Environment]::SetEnvironmentVariable($name, $value)
}

function Stop-Tree($p) {
  if ($p -and -not $p.HasExited) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & taskkill.exe /PID $p.Id /T /F 2>$null | Out-Null
    $ErrorActionPreference = $old
  }
}

$exitCode = 0
try {
  # Child processes inherit these; they are restored when the script ends.
  Set-ChildEnv 'OLLAMA_HOST' $OllamaUrl
  if ($Mock) { Set-ChildEnv 'LATENT_MOCK' '1' }
  if ($AirGap) { Set-ChildEnv 'LATENT_OFFLINE' '1' }
  Set-ChildEnv 'LATENT_BACKEND_URL' "http://127.0.0.1:$BackendPort"
  Set-ChildEnv 'PYTHONUNBUFFERED' '1'

  Info "backend  -> http://localhost:$BackendPort (bound to $BindHost)"
  $backendArgs = @('-m', 'uvicorn', 'app.main:app', '--host', $BindHost, '--port', "$BackendPort")
  $backendProc = Start-Process -FilePath $VenvPy -ArgumentList $backendArgs -WorkingDirectory $Backend -NoNewWindow -PassThru
  $procs += $backendProc

  Info 'waiting for /api/health (real mode loads the PII model first, which can take a minute)...'
  $health = $null
  for ($i = 0; $i -lt 180; $i++) {
    if ($backendProc.HasExited) { throw 'the backend exited during startup; see the log above' }
    $health = Get-Http "http://127.0.0.1:$BackendPort/api/health"
    if ($health) { break }
    Start-Sleep -Seconds 1
  }
  if (-not $health) { throw 'the backend did not answer /api/health within 180 s' }
  Ok ("backend healthy: status={0} ollama={1} model={2} model_loaded={3} tavily_key={4}" -f `
      $health.status, $health.ollama, $health.model, $health.model_loaded, $health.tavily_key)

  Info "frontend -> http://localhost:$FrontendPort (bound to $BindHost)"
  $viteArgs = @('node_modules\vite\bin\vite.js', '--clearScreen', 'false', '--host', $BindHost)
  $frontendProc = Start-Process -FilePath 'node.exe' -ArgumentList $viteArgs -WorkingDirectory $Frontend -NoNewWindow -PassThru
  $procs += $frontendProc

  $up = $false
  for ($i = 0; $i -lt 60 -and -not $up; $i++) {
    if ($frontendProc.HasExited) { throw 'the frontend exited during startup; see the log above' }
    try { Invoke-WebRequest -Uri "http://127.0.0.1:$FrontendPort/" -TimeoutSec 2 -UseBasicParsing | Out-Null; $up = $true } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $up) { throw "the frontend did not answer on :$FrontendPort within 60 s" }

  Write-Host ""
  Ok "Latent is up: http://localhost:$FrontendPort"
  if ($Wsl) {
    Info "From WSL use the Windows host address: http://<host>:$FrontendPort, http://<host>:$BackendPort/api/health"
    Info "and OLLAMA_HOST=http://<host>:11434, where <host> is: ip route show default | awk '{print `$3}'"
    Info '(with WSL mirrored networking, localhost works). Windows Firewall may ask to allow Python and Node.'
  }
  if (-not $NoBrowser) { Start-Process "http://localhost:$FrontendPort/" | Out-Null }
  Info 'Press Ctrl+C (or close this window) to stop the backend and the frontend. Ollama keeps running.'

  while (-not $backendProc.HasExited -and -not $frontendProc.HasExited) { Start-Sleep -Milliseconds 500 }
  $which = if ($backendProc.HasExited) { 'backend' } else { 'frontend' }
  Write-Host ""
  Write-Host "the $which exited; shutting down" -ForegroundColor Yellow
  $exitCode = 1
} catch {
  Write-Host ""
  Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
  $exitCode = 1
} finally {
  # Runs on normal exit, on errors and on Ctrl+C.
  if ($procs.Count -gt 0) { Write-Host "==> stopping the backend and the frontend" }
  foreach ($p in $procs) { Stop-Tree $p }
  foreach ($name in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnv[$name]) }
}
exit $exitCode
