# One-command start for CodePair (Windows PowerShell).
#
#   .\start.ps1
#
# It checks Docker, starts Redis, builds the sandbox image (first run only),
# installs npm packages (first run only) and starts the server and web app.
# Open http://localhost:3100 when it says "Ready".

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }

Step 'Checking Docker'
docker info --format '{{.ServerVersion}}' *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Docker is not running. Start Docker Desktop and run this script again.' -ForegroundColor Red
    exit 1
}

Step 'Starting Redis (docker compose)'
docker compose up -d
if ($LASTEXITCODE -ne 0) { exit 1 }

docker image inspect codepair-sandbox *> $null
if ($LASTEXITCODE -ne 0) {
    Step 'Building the sandbox image (first run only, about a minute)'
    docker build -t codepair-sandbox sandbox
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

if (-not (Test-Path node_modules)) {
    Step 'Installing npm packages (first run only)'
    npm install
}
if (-not (Test-Path server/node_modules) -or -not (Test-Path web/node_modules)) {
    npm run setup
}

Step 'Starting server (http://localhost:4100) and web app (http://localhost:3100)'
Write-Host 'Open http://localhost:3100  -  press Ctrl+C to stop.' -ForegroundColor Green
npm run dev
