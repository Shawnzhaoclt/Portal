$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $scriptRoot "sync.settings.json"
$startLauncher = Join-Path $scriptRoot "start_sync_hidden.vbs"
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json

function Resolve-ConfiguredPath([string] $value) {
    $expanded = [Environment]::ExpandEnvironmentVariables($value)
    if ([System.IO.Path]::IsPathRooted($expanded)) {
        return [System.IO.Path]::GetFullPath($expanded)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $scriptRoot $expanded))
}

$outputDatabase = Resolve-ConfiguredPath ([string] $(
    if ($config.sqliteDatabase) { $config.sqliteDatabase } else { $config.outputDatabase }
))
$legacyOutputDatabase = if ($config.outputDatabase) {
    Resolve-ConfiguredPath ([string] $config.outputDatabase)
}
else {
    $null
}
$publicationManifest = if ($config.sqliteManifest) {
    Resolve-ConfiguredPath ([string] $config.sqliteManifest)
}
else {
    Join-Path (Split-Path -Parent $outputDatabase) "$([System.IO.Path]::GetFileNameWithoutExtension($outputDatabase)).current.json"
}
if ($config.syncLogsDirectory) {
    $logDirectory = Resolve-ConfiguredPath ([string] $config.syncLogsDirectory)
}
else {
    $logDirectory = Join-Path (Split-Path -Parent $outputDatabase) "logs"
}
$statusHistoryPath = if ($config.syncStatusFile) {
    Resolve-ConfiguredPath ([string] $config.syncStatusFile)
}
else {
    Join-Path $logDirectory "portal-sync-status.json"
}
$scheduleConfig = $config.schedule
$allowedStartTime = [TimeSpan]::Parse($(if ($scheduleConfig.allowedStartTime) { $scheduleConfig.allowedStartTime } else { "07:00" }))
$firstRunTime = [TimeSpan]::Parse($(if ($scheduleConfig.firstRunTime) { $scheduleConfig.firstRunTime } else { "07:30" }))
$lastRunTime = [TimeSpan]::Parse($(if ($scheduleConfig.lastRunTime) { $scheduleConfig.lastRunTime } else { "16:30" }))
$exitTime = [TimeSpan]::Parse($(if ($scheduleConfig.exitTime) { $scheduleConfig.exitTime } else { "16:35" }))

function Test-ManualStartAllowed {
    $currentTime = (Get-Date).TimeOfDay
    return $currentTime -ge $allowedStartTime -and $currentTime -le $lastRunTime
}

function Get-PublishedDatabase {
    if (Test-Path -LiteralPath $publicationManifest -PathType Leaf) {
        try {
            $manifest = Get-Content -LiteralPath $publicationManifest -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($manifest.database) {
                $candidate = [string] $manifest.database
                if (-not [System.IO.Path]::IsPathRooted($candidate)) {
                    $candidate = Join-Path (Split-Path -Parent $publicationManifest) $candidate
                }
                $candidate = [System.IO.Path]::GetFullPath($candidate)
                if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                    return $candidate
                }
            }
        }
        catch {
            # Keep the monitor responsive if a malformed manifest is encountered.
        }
    }
    if (Test-Path -LiteralPath $outputDatabase -PathType Leaf) {
        return $outputDatabase
    }
    if ($legacyOutputDatabase -and (Test-Path -LiteralPath $legacyOutputDatabase -PathType Leaf)) {
        return $legacyOutputDatabase
    }
    return $null
}

function Format-ScheduleTime([TimeSpan] $time) {
    return (Get-Date).Date.Add($time).ToString("h:mm tt")
}

function Get-SyncProcesses {
    return @(
        Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine.Contains("sync_portal_sources.py") -and
                $_.CommandLine.Contains("--schedule")
            }
    )
}

function Get-NextRunText([bool] $isRunning) {
    if (-not $isRunning) {
        return "Scheduler stopped"
    }

    $now = Get-Date
    $firstRun = $now.Date.Add($firstRunTime)
    $lastRun = $now.Date.Add($lastRunTime)
    if ($now -lt $firstRun) {
        return $firstRun.ToString("hh:mm tt")
    }
    if ($now -ge $lastRun) {
        return "No runs remain today"
    }

    $elapsedMinutes = ($now - $firstRun).TotalMinutes
    $intervals = [Math]::Floor($elapsedMinutes / 5) + 1
    return $firstRun.AddMinutes($intervals * 5).ToString("hh:mm tt")
}

$portalBlue = [System.Drawing.Color]::FromArgb(31, 91, 145)
$softBlue = [System.Drawing.Color]::FromArgb(236, 244, 250)
$mutedText = [System.Drawing.Color]::FromArgb(92, 110, 128)
$successColor = [System.Drawing.Color]::FromArgb(29, 120, 73)
$stoppedColor = [System.Drawing.Color]::FromArgb(177, 45, 38)

$form = New-Object System.Windows.Forms.Form
$form.Text = "Portal Data Sync Monitor"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(940, 680)
$form.MinimumSize = New-Object System.Drawing.Size(760, 520)
$form.BackColor = [System.Drawing.Color]::White
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$header = New-Object System.Windows.Forms.Panel
$header.Dock = "Top"
$header.Height = 68
$header.BackColor = $portalBlue
$form.Controls.Add($header)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Portal Data Sync"
$title.ForeColor = [System.Drawing.Color]::White
$title.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 17)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(20, 10)
$header.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = "Workstation source publication monitor"
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(222, 235, 246)
$subtitle.AutoSize = $true
$subtitle.Location = New-Object System.Drawing.Point(22, 40)
$header.Controls.Add($subtitle)

function New-CommandButton([string] $text, [int] $width) {
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $text
    $button.Width = $width
    $button.Height = 34
    $button.FlatStyle = "Flat"
    $button.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(168, 191, 212)
    $button.ForeColor = $portalBlue
    $button.BackColor = [System.Drawing.Color]::White
    return $button
}

$statusPanel = New-Object System.Windows.Forms.Panel
$statusPanel.Dock = "Top"
$statusPanel.Height = 108
$statusPanel.BackColor = [System.Drawing.Color]::FromArgb(252, 242, 241)
$form.Controls.Add($statusPanel)

$statusAccent = New-Object System.Windows.Forms.Panel
$statusAccent.Dock = "Left"
$statusAccent.Width = 8
$statusAccent.BackColor = $stoppedColor
$statusPanel.Controls.Add($statusAccent)

$statusHeading = New-Object System.Windows.Forms.Label
$statusHeading.Text = "CHECKING"
$statusHeading.AutoSize = $true
$statusHeading.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 20)
$statusHeading.ForeColor = $stoppedColor
$statusHeading.Location = New-Object System.Drawing.Point(26, 20)
$statusPanel.Controls.Add($statusHeading)

$statusDetail = New-Object System.Windows.Forms.Label
$statusDetail.Text = "Reading scheduler state..."
$statusDetail.AutoSize = $true
$statusDetail.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$statusDetail.ForeColor = $mutedText
$statusDetail.Location = New-Object System.Drawing.Point(29, 62)
$statusPanel.Controls.Add($statusDetail)

$buttonBar = New-Object System.Windows.Forms.FlowLayoutPanel
$buttonBar.Dock = "Right"
$buttonBar.Width = 440
$buttonBar.Padding = New-Object System.Windows.Forms.Padding(8, 34, 14, 8)
$buttonBar.WrapContents = $false
$buttonBar.BackColor = [System.Drawing.Color]::Transparent
$statusPanel.Controls.Add($buttonBar)

$startButton = New-CommandButton "Start" 92
$stopButton = New-CommandButton "Stop" 92
$refreshButton = New-CommandButton "Refresh" 100
$openLogsButton = New-CommandButton "Open Logs" 116
$buttonBar.Controls.AddRange(@($startButton, $stopButton, $refreshButton, $openLogsButton))

$summary = New-Object System.Windows.Forms.TableLayoutPanel
$summary.Dock = "Top"
$summary.Height = 105
$summary.Padding = New-Object System.Windows.Forms.Padding(15, 12, 15, 10)
$summary.ColumnCount = 4
$summary.RowCount = 2
$summary.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 25)))
$summary.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 25)))
$summary.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 25)))
$summary.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 25)))
$summary.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Absolute", 26)))
$summary.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Percent", 100)))
$form.Controls.Add($summary)

function New-SummaryLabel([string] $text, [bool] $heading) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $text
    $label.Dock = "Fill"
    $label.TextAlign = "MiddleLeft"
    if ($heading) {
        $label.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
        $label.ForeColor = $mutedText
    }
    else {
        $label.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 12)
        $label.ForeColor = [System.Drawing.Color]::FromArgb(25, 42, 58)
    }
    return $label
}

$summary.Controls.Add((New-SummaryLabel "ACTIVITY" $true), 0, 0)
$summary.Controls.Add((New-SummaryLabel "NEXT RUN" $true), 1, 0)
$summary.Controls.Add((New-SummaryLabel "PUBLISHED DATABASE" $true), 2, 0)
$summary.Controls.Add((New-SummaryLabel "LATEST RESULT" $true), 3, 0)
$activityValue = New-SummaryLabel "Checking..." $false
$nextRunValue = New-SummaryLabel "Checking..." $false
$databaseValue = New-SummaryLabel "Checking..." $false
$resultValue = New-SummaryLabel "Checking..." $false
$summary.Controls.Add($activityValue, 0, 1)
$summary.Controls.Add($nextRunValue, 1, 1)
$summary.Controls.Add($databaseValue, 2, 1)
$summary.Controls.Add($resultValue, 3, 1)

$runsHeader = New-Object System.Windows.Forms.TableLayoutPanel
$runsHeader.Dock = "Top"
$runsHeader.Height = 44
$runsHeader.Padding = New-Object System.Windows.Forms.Padding(15, 5, 15, 5)
$runsHeader.BackColor = [System.Drawing.Color]::White
$runsHeader.ColumnCount = 3
$runsHeader.RowCount = 1
$runsHeader.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Percent", 100)))
$runsHeader.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Absolute", 48)))
$runsHeader.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle("Absolute", 132)))
$runsHeader.RowStyles.Add((New-Object System.Windows.Forms.RowStyle("Percent", 100)))
$form.Controls.Add($runsHeader)

$runsTitle = New-Object System.Windows.Forms.Label
$runsTitle.Text = "Synchronization runs"
$runsTitle.Dock = "Fill"
$runsTitle.TextAlign = "MiddleLeft"
$runsTitle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 11)
$runsTitle.ForeColor = $portalBlue
$runsHeader.Controls.Add($runsTitle, 0, 0)

$runDatePicker = New-Object System.Windows.Forms.DateTimePicker
$runDatePicker.Dock = "Fill"
$runDatePicker.Margin = New-Object System.Windows.Forms.Padding(3, 2, 0, 2)
$runDatePicker.Format = "Custom"
$runDatePicker.CustomFormat = "MM/dd/yyyy"
$runDatePicker.Value = (Get-Date).Date
$runDatePicker.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$runsHeader.Controls.Add($runDatePicker, 2, 0)

$runDateLabel = New-Object System.Windows.Forms.Label
$runDateLabel.Text = "DATE"
$runDateLabel.Dock = "Fill"
$runDateLabel.TextAlign = "MiddleLeft"
$runDateLabel.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
$runDateLabel.ForeColor = $mutedText
$runsHeader.Controls.Add($runDateLabel, 1, 0)

$runGrid = New-Object System.Windows.Forms.DataGridView
$runGrid.Dock = "Fill"
$runGrid.ReadOnly = $true
$runGrid.AllowUserToAddRows = $false
$runGrid.AllowUserToDeleteRows = $false
$runGrid.AllowUserToResizeRows = $false
$runGrid.MultiSelect = $false
$runGrid.SelectionMode = "FullRowSelect"
$runGrid.ScrollBars = "Both"
$runGrid.RowHeadersVisible = $false
$runGrid.AutoGenerateColumns = $false
$runGrid.AutoSizeRowsMode = "None"
$runGrid.RowTemplate.Height = 34
$runGrid.BackgroundColor = [System.Drawing.Color]::White
$runGrid.BorderStyle = "FixedSingle"
$runGrid.GridColor = [System.Drawing.Color]::FromArgb(218, 229, 238)
$runGrid.EnableHeadersVisualStyles = $false
$runGrid.ColumnHeadersHeight = 36
$runGrid.ColumnHeadersHeightSizeMode = "DisableResizing"
$runGrid.ColumnHeadersDefaultCellStyle.BackColor = $softBlue
$runGrid.ColumnHeadersDefaultCellStyle.ForeColor = $portalBlue
$runGrid.ColumnHeadersDefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
$runGrid.ColumnHeadersDefaultCellStyle.Alignment = "MiddleCenter"
$runGrid.DefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$runGrid.DefaultCellStyle.ForeColor = [System.Drawing.Color]::FromArgb(25, 42, 58)
$runGrid.DefaultCellStyle.SelectionBackColor = [System.Drawing.Color]::FromArgb(215, 231, 244)
$runGrid.DefaultCellStyle.SelectionForeColor = [System.Drawing.Color]::FromArgb(25, 42, 58)
$runGrid.AlternatingRowsDefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(247, 250, 252)

[void] $runGrid.Columns.Add("Status", "STATUS")
[void] $runGrid.Columns.Add("Started", "STARTED")
[void] $runGrid.Columns.Add("Finished", "FINISHED")
[void] $runGrid.Columns.Add("Duration", "DURATION")
[void] $runGrid.Columns.Add("Details", "DETAILS")
$runGrid.Columns[0].Width = 105
$runGrid.Columns[1].Width = 165
$runGrid.Columns[2].Width = 165
$runGrid.Columns[3].Width = 90
$runGrid.Columns[4].AutoSizeMode = "Fill"
$runGrid.Columns[0].DefaultCellStyle.Alignment = "MiddleCenter"
$runGrid.Columns[1].DefaultCellStyle.Alignment = "MiddleCenter"
$runGrid.Columns[2].DefaultCellStyle.Alignment = "MiddleCenter"
$runGrid.Columns[3].DefaultCellStyle.Alignment = "MiddleCenter"
$runGrid.Columns[4].DefaultCellStyle.Alignment = "MiddleLeft"
$form.Controls.Add($runGrid)

# WinForms docks controls in reverse add order. Re-add them bottom-to-top.
$form.Controls.Clear()
$form.Controls.Add($runGrid)
$form.Controls.Add($runsHeader)
$form.Controls.Add($summary)
$form.Controls.Add($statusPanel)
$form.Controls.Add($header)

function Format-RunTimestamp($value) {
    if (-not $value) {
        return "-"
    }
    try {
        return ([DateTimeOffset]::Parse([string] $value)).ToLocalTime().ToString("MM/dd/yyyy hh:mm:ss tt")
    }
    catch {
        return [string] $value
    }
}

function Get-RunLocalDate($value) {
    if (-not $value) {
        return $null
    }
    try {
        return ([DateTimeOffset]::Parse([string] $value)).ToLocalTime().Date
    }
    catch {
        return $null
    }
}

function Get-RunHistory {
    if (-not (Test-Path -LiteralPath $statusHistoryPath -PathType Leaf)) {
        return @()
    }
    $payload = Get-Content -LiteralPath $statusHistoryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return @($payload.runs)
}

function Set-RunGrid($runs) {
    $firstVisibleRow = if ($runGrid.Rows.Count -gt 0) {
        $runGrid.FirstDisplayedScrollingRowIndex
    }
    else {
        -1
    }
    $selectedDate = $runDatePicker.Value.Date
    $filteredRuns = @($runs | Where-Object { (Get-RunLocalDate $_.started_at) -eq $selectedDate })
    $runGrid.Rows.Clear()
    foreach ($run in $filteredRuns) {
        $duration = if ($null -ne $run.duration_seconds) {
            "{0:N1} sec" -f [double] $run.duration_seconds
        }
        else {
            "-"
        }
        $rowIndex = $runGrid.Rows.Add(
            [string] $run.status,
            (Format-RunTimestamp $run.started_at),
            (Format-RunTimestamp $run.finished_at),
            $duration,
            [string] $run.details
        )
        $statusCell = $runGrid.Rows[$rowIndex].Cells[0]
        $statusCell.Style.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
        $statusCell.Style.ForeColor = switch ([string] $run.status) {
            "Succeeded" { $successColor }
            "Running" { $portalBlue }
            "Failed" { $stoppedColor }
            default { [System.Drawing.Color]::FromArgb(170, 105, 25) }
        }
    }
    if ($runGrid.Rows.Count -eq 0) {
        $rowIndex = $runGrid.Rows.Add(
            "No runs",
            "-",
            "-",
            "-",
            "No synchronization attempts were recorded for $($selectedDate.ToString('MM/dd/yyyy'))."
        )
        $runGrid.Rows[$rowIndex].Cells[0].Style.ForeColor = $mutedText
    }
    $runGrid.ClearSelection()
    if ($firstVisibleRow -ge 0 -and $firstVisibleRow -lt $runGrid.Rows.Count) {
        $runGrid.FirstDisplayedScrollingRowIndex = $firstVisibleRow
    }
}

function Refresh-Monitor {
    try {
        $processes = Get-SyncProcesses
        $isRunning = $processes.Count -gt 0
        $startAllowed = Test-ManualStartAllowed
        $statusHeading.Text = if ($isRunning) { "RUNNING" } else { "STOPPED" }
        $statusHeading.ForeColor = if ($isRunning) { $successColor } else { $stoppedColor }
        $statusAccent.BackColor = if ($isRunning) { $successColor } else { $stoppedColor }
        $statusPanel.BackColor = if ($isRunning) {
            [System.Drawing.Color]::FromArgb(238, 248, 242)
        }
        else {
            [System.Drawing.Color]::FromArgb(252, 242, 241)
        }
        $statusDetail.Text = if ($isRunning) {
            "Automatic synchronization is active and will exit at $(Format-ScheduleTime $exitTime)."
        }
        elseif (-not $startAllowed) {
            "Start is available daily from $(Format-ScheduleTime $allowedStartTime) through $(Format-ScheduleTime $lastRunTime)."
        }
        else {
            "The scheduler is not running. Select Start to resume synchronization."
        }
        $activityValue.Text = if ($isRunning) { "Schedule active" } else { "Not running" }
        $activityValue.ForeColor = if ($isRunning) { $successColor } else { $stoppedColor }
        $nextRunValue.Text = Get-NextRunText $isRunning
        $startButton.Enabled = -not $isRunning -and $startAllowed
        $stopButton.Enabled = $isRunning

        $publishedDatabase = Get-PublishedDatabase
        if ($publishedDatabase) {
            $database = Get-Item -LiteralPath $publishedDatabase
            $sizeMb = [Math]::Round($database.Length / 1MB, 1)
            $databaseValue.Text = "{0} MB`r`n{1}" -f $sizeMb, $database.LastWriteTime.ToString("MM/dd/yyyy hh:mm tt")
            $databaseValue.ForeColor = [System.Drawing.Color]::FromArgb(25, 42, 58)
        }
        else {
            $databaseValue.Text = "Not published"
            $databaseValue.ForeColor = $stoppedColor
        }

        $runs = @(Get-RunHistory)
        Set-RunGrid $runs
        if ($runs.Count -gt 0) {
            $latestRun = $runs[0]
            $resultValue.Text = "{0}`r`n{1}" -f $latestRun.status, (Format-RunTimestamp $latestRun.finished_at)
            $resultValue.ForeColor = switch ([string] $latestRun.status) {
                "Succeeded" { $successColor }
                "Running" { $portalBlue }
                "Failed" { $stoppedColor }
                default { [System.Drawing.Color]::FromArgb(170, 105, 25) }
            }
        }
        else {
            $resultValue.Text = "No runs recorded"
            $resultValue.ForeColor = $mutedText
        }
    }
    catch {
        $statusHeading.Text = "UNAVAILABLE"
        $statusHeading.ForeColor = $stoppedColor
        $statusAccent.BackColor = $stoppedColor
        $statusDetail.Text = "The monitor could not read the scheduler state."
        $activityValue.Text = "Status unavailable"
        $activityValue.ForeColor = $stoppedColor
        $resultValue.Text = "Monitor error"
        $resultValue.ForeColor = $stoppedColor
        Set-RunGrid @([pscustomobject]@{
            status = "Failed"
            started_at = $null
            finished_at = $null
            duration_seconds = $null
            details = $_.Exception.Message
        })
    }
}

$startButton.Add_Click({
    if (-not (Test-ManualStartAllowed)) {
        [System.Windows.Forms.MessageBox]::Show(
            "The scheduler can only be started from $(Format-ScheduleTime $allowedStartTime) through $(Format-ScheduleTime $lastRunTime).",
            "Portal Data Sync",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
        Refresh-Monitor
    }
    elseif ((Get-SyncProcesses).Count -eq 0) {
        Start-Process -FilePath "wscript.exe" -ArgumentList ('"{0}"' -f $startLauncher)
        Start-Sleep -Milliseconds 900
        Refresh-Monitor
    }
})

$stopButton.Add_Click({
    $answer = [System.Windows.Forms.MessageBox]::Show(
        "Stop the Portal data sync scheduler?",
        "Portal Data Sync",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question
    )
    if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
        foreach ($process in (Get-SyncProcesses)) {
            Invoke-CimMethod -InputObject $process -MethodName Terminate | Out-Null
        }
        Start-Sleep -Milliseconds 500
        Refresh-Monitor
    }
})

$refreshButton.Add_Click({ Refresh-Monitor })
$runDatePicker.Add_ValueChanged({ Refresh-Monitor })
$openLogsButton.Add_Click({
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    Start-Process -FilePath "explorer.exe" -ArgumentList ('"{0}"' -f $logDirectory)
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Refresh-Monitor })
$form.Add_Shown({
    Refresh-Monitor
    $timer.Start()
})
$form.Add_FormClosed({ $timer.Stop() })

[void] $form.ShowDialog()
