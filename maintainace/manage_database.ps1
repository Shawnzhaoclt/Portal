param(
  [ValidateSet("init-db", "upgrade-db", "backup-db", "restore-db", "summary")]
  [string]$Action = "init-db",
  [string]$DatabasePath = "",
  [string]$OrgCsvPath = "",
  [string]$BackupPath = "",
  [string]$AdminEmails = "",
  [string]$SystemAdminEmails = "",
  [switch]$SeedOrg,
  [switch]$Force,
  [switch]$NoSafetyBackup,
  [switch]$Json,
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $projectRoot
try {
  $arguments = @("-m", "maintainace.portal_maintenance", $Action)
  if ($DatabasePath.Trim()) {
    $arguments += @("--db", $DatabasePath)
  }
  if ($OrgCsvPath.Trim() -and ($Action -eq "init-db" -or $Action -eq "upgrade-db")) {
    $arguments += @("--org-csv", $OrgCsvPath)
  }
  if ($BackupPath.Trim() -and ($Action -eq "backup-db" -or $Action -eq "restore-db")) {
    $arguments += @("--backup", $BackupPath)
  }
  if ($AdminEmails.Trim() -and ($Action -eq "init-db" -or $Action -eq "upgrade-db")) {
    $arguments += @("--admin-emails", $AdminEmails)
  }
  if ($SystemAdminEmails.Trim() -and ($Action -eq "init-db" -or $Action -eq "upgrade-db")) {
    $arguments += @("--system-admin-emails", $SystemAdminEmails)
  }
  if ($SeedOrg -and $Action -eq "upgrade-db") {
    $arguments += "--seed-org"
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
