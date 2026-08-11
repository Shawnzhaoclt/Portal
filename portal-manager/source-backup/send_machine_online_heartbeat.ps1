param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "backup_duckdb_files.json")
)

$ErrorActionPreference = "Stop"

try {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw "Configuration file not found: $ConfigPath"
    }

    $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
    $email = $config.email

    if ($null -eq $email) {
        throw "Missing email configuration in: $ConfigPath"
    }
    if ($email.mechanism -ne "outlook") {
        throw "Unsupported email mechanism: $($email.mechanism)"
    }
    if (-not $email.to_addresses -or $email.to_addresses.Count -eq 0) {
        throw "At least one notification recipient is required"
    }

    $outlook = $null
    $message = $null
    $timestamp = Get-Date
    $uptime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime

    try {
        $outlook = New-Object -ComObject Outlook.Application
        $message = $outlook.CreateItem(0)
        $message.To = ($email.to_addresses -join ";")
        $message.Subject = "Machine Online Check: $env:COMPUTERNAME"
        $message.Body = @"
The scheduled Sunday machine online check completed successfully.

Computer: $env:COMPUTERNAME
User: $env:USERDOMAIN\$env:USERNAME
Checked: $($timestamp.ToString("yyyy-MM-dd HH:mm:ss zzz"))
Last Boot: $($uptime.ToString("yyyy-MM-dd HH:mm:ss zzz"))

This email means the machine is online and the scheduled task was able to run.
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

    Write-Output "Machine online heartbeat email sent successfully."
    exit 0
}
catch {
    Write-Error "Machine online heartbeat email failed: $($_.Exception.Message)"
    exit 1
}

