#!/usr/bin/env pwsh
# Runs the full local build pipeline: install, build, lint, test, pack.
# Stops at the first failing step (non-zero exit code).

$ErrorActionPreference = 'Stop'

function Invoke-Step {
    param(
        [string]$Name,
        [string]$Command
    )

    Write-Host ">> $Name" -ForegroundColor Cyan
    Invoke-Expression $Command
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: $Name (exit code $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Invoke-Step -Name 'npm install'   -Command 'npm i'
Invoke-Step -Name 'npm run build' -Command 'npm run build'
Invoke-Step -Name 'npm run lint'  -Command 'npm run lint'
Invoke-Step -Name 'npm run test'  -Command 'npm run test'
Invoke-Step -Name 'npm pack'      -Command 'npm pack'

Write-Host "Build pipeline completed successfully." -ForegroundColor Green
