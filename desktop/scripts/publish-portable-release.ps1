[CmdletBinding()]
param(
    [string]$SourceDirectory,
    [string]$ReleaseRoot = "G:\Strategic Planning\Planning\stm_risk_app",
    [Parameter(Mandatory = $true)]
    [ValidateSet("portal-exe", "full")]
    [string]$UpdateMode
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

function Get-PayloadManifest {
    param(
        [string]$Version,
        [string]$Mode,
        [string]$PayloadPath,
        [string]$InstallationPayloadPath
    )

    $payload = [ordered]@{
        file = [System.IO.Path]::GetFileName($PayloadPath)
        sha256 = (Get-FileHash -LiteralPath $PayloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
        size = (Get-Item -LiteralPath $PayloadPath).Length
    }
    $installationPayload = [ordered]@{
        file = [System.IO.Path]::GetFileName($InstallationPayloadPath)
        sha256 = (Get-FileHash -LiteralPath $InstallationPayloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
        size = (Get-Item -LiteralPath $InstallationPayloadPath).Length
    }
    [ordered]@{
        schemaVersion = 1
        version = $Version
        updateMode = $Mode
        payload = $payload
        installationPayload = $installationPayload
        preservePaths = @("data")
        publishedAtUtc = [DateTime]::UtcNow.ToString("o")
    }
}

function New-PortalInstallationArchive {
    param(
        [string]$Source,
        [string]$Destination
    )

    # tar.exe -a chooses the archive format from the output extension. Keep
    # .zip as the final suffix while staging; a .part suffix creates an
    # uncompressed TAR that is only named .zip after publication.
    $temporaryArchive = "$Destination.part.zip"
    Remove-Item -LiteralPath $temporaryArchive -Force -ErrorAction SilentlyContinue
    & tar.exe -a -c -f $temporaryArchive `
        --exclude=data `
        --exclude=./data `
        --exclude=config/system.db `
        --exclude=./config/system.db `
        -C $Source .
    if ($LASTEXITCODE -ne 0) {
        throw "Windows tar.exe could not create the complete Portal installation package."
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($temporaryArchive)
    try {
        if ($archive.Entries.Count -eq 0) {
            throw "The Portal installation ZIP is empty."
        }
    } finally {
        $archive.Dispose()
    }
    Move-Item -LiteralPath $temporaryArchive -Destination $Destination -Force
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
$updater = Join-Path $SourceDirectory "runtime\PortalUpdater.exe"
$spatialExtension = Join-Path $SourceDirectory "runtime\duckdb\extensions\spatial.duckdb_extension"
foreach ($required in @($versionPath, $portalExecutable, $updater, $spatialExtension)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Portable release source is missing $required"
    }
}
$systemDatabase = Join-Path $SourceDirectory "config\system.db"
if (Test-Path -LiteralPath $systemDatabase) {
    throw "Portable release source contains config\system.db. Rebuild Portal Desktop so no plaintext catalog is distributed."
}

$packagedVersion = (Get-Content -LiteralPath $versionPath -Raw).Trim()
$version = $packagedVersion
if ($version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
    throw "The packaged VERSION file must contain a semantic version."
}

$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null

$installationPayloadPath = Join-Path $ReleaseRoot "Portal-Desktop-$version.zip"
New-PortalInstallationArchive -Source $SourceDirectory -Destination $installationPayloadPath

switch ($UpdateMode) {
    "portal-exe" {
        $payloadPath = Join-Path $ReleaseRoot "Portal-$version.exe"
        Copy-Item -LiteralPath $portalExecutable -Destination $payloadPath -Force
    }
    "full" {
        $payloadPath = $installationPayloadPath
    }
}

$manifest = Get-PayloadManifest `
    -Version $version `
    -Mode $UpdateMode `
    -PayloadPath $payloadPath `
    -InstallationPayloadPath $installationPayloadPath
$publishedUpdater = Join-Path $ReleaseRoot "PortalUpdater.exe"
$temporaryUpdater = "$publishedUpdater.part"
Copy-Item -LiteralPath $updater -Destination $temporaryUpdater -Force
Move-Item -LiteralPath $temporaryUpdater -Destination $publishedUpdater -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "desktop\release\Download-Portal.bat") -Destination (Join-Path $ReleaseRoot "Download-Portal.bat") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "desktop\release\Remove-Portal.bat") -Destination (Join-Path $ReleaseRoot "Remove-Portal.bat") -Force
$legacyInstaller = Join-Path $ReleaseRoot "Install-Portal.bat"
if (Test-Path -LiteralPath $legacyInstaller) {
    Remove-Item -LiteralPath $legacyInstaller -Force
}
Write-Manifest -Manifest $manifest -Destination (Join-Path $ReleaseRoot "portal-release.json")

$legacyBootstrapManifest = Join-Path $ReleaseRoot "portal-bootstrap.json"
if (Test-Path -LiteralPath $legacyBootstrapManifest) {
    Remove-Item -LiteralPath $legacyBootstrapManifest -Force
}

Write-Host "Published Portal $UpdateMode release $version"
Write-Host "Release manifest: $(Join-Path $ReleaseRoot 'portal-release.json')"
Write-Host "First-time download script: $(Join-Path $ReleaseRoot 'Download-Portal.bat')"
Write-Host "Complete removal script: $(Join-Path $ReleaseRoot 'Remove-Portal.bat')"
