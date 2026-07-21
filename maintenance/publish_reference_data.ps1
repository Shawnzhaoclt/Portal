param(
    [string]$SettingsPath = (Join-Path $PSScriptRoot "..\dist\Portal-Desktop\config\portal.settings.json"),
    [string]$SharedDataRoot,
    [string]$MapSourceRoot
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf)) {
    throw "Portal settings were not found: $SettingsPath"
}

$settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
if (-not $SharedDataRoot) {
    $SharedDataRoot = [string]$settings.shared.dataRoot
}
if (-not $MapSourceRoot) {
    $MapSourceRoot = [string]$settings.maintenance.mapSourceRoot
}
if (-not $SharedDataRoot) {
    throw "shared.dataRoot is not configured in $SettingsPath"
}
if (-not $MapSourceRoot) {
    throw "maintenance.mapSourceRoot is not configured in $SettingsPath"
}

$sourceRoot = (Resolve-Path -LiteralPath $MapSourceRoot).Path
$sharedRoot = [System.IO.Path]::GetFullPath($SharedDataRoot)
$mapRoot = Join-Path $sharedRoot "maptiles"

$publications = @(
    @{ Source = "config"; Destination = "config" },
    @{ Source = "build\maplibre"; Destination = "build\maplibre" },
    @{ Source = "build\pmtiles"; Destination = "build\pmtiles" },
    @{ Source = "build\staging\duckdb"; Destination = "build\staging\duckdb" }
)

foreach ($publication in $publications) {
    $source = Join-Path $sourceRoot $publication.Source
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        throw "Required reference-data directory was not found: $source"
    }

    $destination = Join-Path $mapRoot $publication.Destination
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -Path (Join-Path $source "*") -Destination $destination -Recurse -Force
    Write-Host "Published $source -> $destination"
}

$requiredFiles = @(
    (Join-Path $sharedRoot "intermediate\amteam\amteam.duckdb"),
    (Join-Path $mapRoot "config\project.toml"),
    (Join-Path $mapRoot "build\maplibre\manifest.json"),
    (Join-Path $mapRoot "build\pmtiles\planning_project.pmtiles"),
    (Join-Path $mapRoot "build\staging\duckdb\stm_risk.duckdb")
)

foreach ($requiredFile in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Published reference-data file is missing: $requiredFile"
    }
}

Write-Host "Reference data is ready under $sharedRoot"
