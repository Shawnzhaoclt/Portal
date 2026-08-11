param(
    [Parameter(Mandatory = $true)]
    [string]$Status,

    [Parameter(Mandatory = $true)]
    [string]$Details
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $PSScriptRoot "backup_duckdb_files.json"

try {
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "Configuration file not found: $configPath"
    }

    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $email = $config.email
    if ($null -eq $email) {
        throw "Missing email configuration in: $configPath"
    }
    if ($email.mechanism -ne "outlook") {
        throw "Unsupported email mechanism: $($email.mechanism)"
    }
    if (-not $email.to_addresses -or $email.to_addresses.Count -eq 0) {
        throw "At least one notification recipient is required"
    }

    $outlook = $null
    $message = $null

    try {
        $outlook = New-Object -ComObject Outlook.Application
        $message = $outlook.CreateItem(0)
        $message.To = ($email.to_addresses -join ";")
        $message.Subject = "STM Risk Data Backup: $Status"
        $message.Body = @"
Status: $Status
Computer: $env:COMPUTERNAME
Completed: $((Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz"))
Details: $Details
"@

        $message.Send()
    }
    finally {
        if ($null -ne $message) {
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($message)
        }
        if ($null -ne $outlook) {
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($outlook)
        }
        [GC]::Collect()
        [GC]::WaitForPendingFinalizers()
    }

    Write-Output "Email notification sent successfully."
    exit 0
}
catch {
    Write-Error "Email notification failed: $($_.Exception.Message)"
    exit 1
}

