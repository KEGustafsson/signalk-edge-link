#!/usr/bin/env pwsh

$ErrorActionPreference = 'Stop'

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Command
    )

    Write-Host ">> $Name" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: $Name (exit code $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Invoke-Step -Name 'npm install'   -Command { npm install }
Invoke-Step -Name 'npm run build' -Command { npm run build }
Invoke-Step -Name 'npm run lint'  -Command { npm run lint }
Invoke-Step -Name 'npm run test'  -Command { npm run test }
Invoke-Step -Name 'npm pack'      -Command { npm pack }

Write-Host "Build pipeline completed successfully." -ForegroundColor Green
