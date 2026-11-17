# One-command start for CodePair (Windows PowerShell).
#
#   .\start.ps1        (or double-click start.cmd)
#
# It starts Docker Desktop if needed, starts Redis, builds the sandbox image
# (first run only), installs npm packages (first run only) and starts the
# server and web app. Open http://localhost:3100 when it says so.

# WHY not $ErrorActionPreference = 'Stop': in Windows PowerShell 5.1, a native
# program (docker, npm) writing to stderr then counts as a fatal error, even
# when we only wanted to test its exit code. Each step checks $LASTEXITCODE.
Set-Location $PSScriptRoot

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host $text -ForegroundColor Red; exit 1 }

# True when the command exits with code 0; all of its output is hidden.
function Test-Command([scriptblock]$command) {
    & $command *> $null
    return $LASTEXITCODE -eq 0
}

Step 'Checking Docker'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail 'Docker is not installed. Install Docker Desktop and run this script again.'
}
if (-not (Test-Command { docker info })) {
    $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path $desktop)) { Fail 'Docker is not running. Start Docker Desktop and run this script again.' }
    Step 'Docker is not running: starting Docker Desktop (can take a minute)'
    Start-Process $desktop
    $deadline = (Get-Date).AddMinutes(3)
    while (-not (Test-Command { docker info })) {
        if ((Get-Date) -gt $deadline) { Fail 'Docker did not start within 3 minutes. Open Docker Desktop and try again.' }
        Start-Sleep -Seconds 3
    }
}

Step 'Starting Redis (docker compose)'
docker compose up -d
if ($LASTEXITCODE -ne 0) { Fail 'Could not start Redis.' }

if (-not (Test-Command { docker image inspect codepair-sandbox })) {
    Step 'Building the sandbox image (first run only, about a minute)'
    docker build -t codepair-sandbox sandbox
    if ($LASTEXITCODE -ne 0) { Fail 'Could not build the sandbox image.' }
}

if (-not (Test-Path node_modules)) {
    Step 'Installing npm packages (first run only)'
    npm install
    if ($LASTEXITCODE -ne 0) { Fail 'npm install failed.' }
}
if (-not (Test-Path server/node_modules) -or -not (Test-Path web/node_modules)) {
    Step 'Installing server and web packages (first run only)'
    npm run setup
    if ($LASTEXITCODE -ne 0) { Fail 'npm install failed.' }
}

Step 'Starting server (http://localhost:4100) and web app (http://localhost:3100)'
Write-Host 'Open http://localhost:3100  -  press Ctrl+C to stop.' -ForegroundColor Green
npm run dev
