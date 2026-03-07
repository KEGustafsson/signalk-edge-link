param(
  [Parameter(Mandatory = $true)]
  [string]$Title,
  [string]$Body = "",
  [string]$Base = "main",
  [string]$Head = "",
  [string]$Status = "draft"
)

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$recordsDir = Join-Path $repoRoot "docs\pr-records"
New-Item -ItemType Directory -Force -Path $recordsDir | Out-Null

if (-not $Head) {
  try {
    $Head = (git -C $repoRoot rev-parse --abbrev-ref HEAD).Trim()
  } catch {
    $Head = ""
  }
}

$commit = ""
try {
  $commit = (git -C $repoRoot rev-parse HEAD).Trim()
} catch {
  $commit = ""
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$slug = ($Title.ToLowerInvariant() -replace "[^a-z0-9]+", "-").Trim("-")
if (-not $slug) {
  $slug = "pr-record"
}

$path = Join-Path $recordsDir "$timestamp-$slug.md"
$createdAt = Get-Date -Format "o"

$lines = @(
  "# $Title",
  "",
  "- Status: $Status",
  "- Base: $Base",
  "- Head: $Head",
  "- Commit: $commit",
  "- Created: $createdAt",
  "",
  "## Summary",
  "",
  $(if ($Body) { $Body } else { "(summary omitted)" }),
  ""
)

Set-Content -Path $path -Value ($lines -join "`n") -Encoding utf8
Write-Output $path
