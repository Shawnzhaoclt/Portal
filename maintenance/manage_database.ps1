param(
  [ValidateSet("init-db", "upgrade-db", "backup-db", "restore-db", "summary")]
  [string]$Action = "init-db",
  [ValidateSet("system", "business")]
  [string]$DatabaseKind = "business",
  [string]$DatabasePath = "",
  [string]$BackupPath = "",
  [switch]$Force,
  [switch]$NoSafetyBackup,
  [switch]$Json,
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $projectRoot
try {
  $arguments = @("-m", "maintenance.portal_maintenance", $Action, "--kind", $DatabaseKind)
  if ($DatabasePath.Trim()) {
    $arguments += @("--db", $DatabasePath)
  }
  if ($BackupPath.Trim() -and ($Action -eq "backup-db" -or $Action -eq "restore-db")) {
    $arguments += @("--backup", $BackupPath)
  }
  if ($Force -and ($Action -eq "backup-db" -or $Action -eq "restore-db")) {
    $arguments += "--force"
  }
  if ($NoSafetyBackup -and $Action -eq "restore-db") {
    $arguments += "--no-safety-backup"
  }
  if ($Json) {
    $arguments += "--json"
  }

  & $Python @arguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}
