[CmdletBinding()]
param(
    [string]$SourceDirectory,
    [string]$ReleaseRoot = "G:\Strategic Planning\Planning\stm_risk_app",
    [Parameter(Mandatory = $true)]
    [ValidateSet("system-db", "portal-exe", "full")]
    [string]$UpdateMode,
    [string]$ReleaseVersion
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

function Get-PayloadManifest {
    param(
        [string]$Version,
        [string]$Mode,
        [string]$PayloadPath
    )

    [ordered]@{
        schemaVersion = 1
        version = $Version
        updateMode = $Mode
        payload = [ordered]@{
            file = [System.IO.Path]::GetFileName($PayloadPath)
            sha256 = (Get-FileHash -LiteralPath $PayloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
            size = (Get-Item -LiteralPath $PayloadPath).Length
        }
        publishedAtUtc = [DateTime]::UtcNow.ToString("o")
    }
}

function Write-Manifest {
    param(
        [object]$Manifest,
        [string]$Destination
    )

    $temporary = "$Destination.part"
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($temporary, ($Manifest | ConvertTo-Json -Depth 5), $utf8)
    Move-Item -LiteralPath $temporary -Destination $Destination -Force
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $SourceDirectory) {
    $SourceDirectory = Join-Path $projectRoot "dist\Portal-Desktop"
}
$SourceDirectory = (Resolve-Path -LiteralPath $SourceDirectory).Path
$versionPath = Join-Path $SourceDirectory "VERSION"
$portalExecutable = Join-Path $SourceDirectory "Portal.exe"
$systemDatabase = Join-Path $SourceDirectory "config\system.db"
$updater = Join-Path $SourceDirectory "runtime\PortalUpdater.exe"
foreach ($required in @($versionPath, $portalExecutable, $systemDatabase, $updater)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Portable release source is missing $required"
    }
}

$packagedVersion = (Get-Content -LiteralPath $versionPath -Raw).Trim()
$version = if ($ReleaseVersion) { $ReleaseVersion.Trim() } else { $packagedVersion }
if ($version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
    throw "ReleaseVersion must be a semantic version."
}
if ($UpdateMode -eq "full" -and $version -ne $packagedVersion) {
    throw "A full release version must match the packaged VERSION file ($packagedVersion). Rebuild the portable folder first."
}

$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null

switch ($UpdateMode) {
    "system-db" {
        $payloadPath = Join-Path $ReleaseRoot "system-$version.db"
        Copy-Item -LiteralPath $systemDatabase -Destination $payloadPath -Force
    }
    "portal-exe" {
        $payloadPath = Join-Path $ReleaseRoot "Portal-$version.exe"
        Copy-Item -LiteralPath $portalExecutable -Destination $payloadPath -Force
    }
    "full" {
        $payloadPath = Join-Path $ReleaseRoot "Portal-Desktop-$version.zip"
        $temporaryArchive = "$payloadPath.part"
        Remove-Item -LiteralPath $temporaryArchive -Force -ErrorAction SilentlyContinue
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::CreateFromDirectory(
            $SourceDirectory,
            $temporaryArchive,
            [System.IO.Compression.CompressionLevel]::Optimal,
            $false
        )
        Move-Item -LiteralPath $temporaryArchive -Destination $payloadPath -Force
    }
}

$manifest = Get-PayloadManifest -Version $version -Mode $UpdateMode -PayloadPath $payloadPath
Write-Manifest -Manifest $manifest -Destination (Join-Path $ReleaseRoot "portal-release.json")

if ($UpdateMode -eq "full") {
    Write-Manifest -Manifest $manifest -Destination (Join-Path $ReleaseRoot "portal-bootstrap.json")
}

Copy-Item -LiteralPath $updater -Destination (Join-Path $ReleaseRoot "PortalUpdater.exe") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "desktop\release\Download-Portal.bat") -Destination (Join-Path $ReleaseRoot "Download-Portal.bat") -Force
$legacyInstaller = Join-Path $ReleaseRoot "Install-Portal.bat"
if (Test-Path -LiteralPath $legacyInstaller) {
    Remove-Item -LiteralPath $legacyInstaller -Force
}

Write-Host "Published Portal $UpdateMode release $version"
Write-Host "Incremental manifest: $(Join-Path $ReleaseRoot 'portal-release.json')"
Write-Host "First-time download script: $(Join-Path $ReleaseRoot 'Download-Portal.bat')"
if ($UpdateMode -ne "full") {
    Write-Host "The existing portal-bootstrap.json remains the full release used for first-time installations."
}
