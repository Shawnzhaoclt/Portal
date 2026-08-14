[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [string]$PythonExecutable,
    [string]$SystemDatabase,
    [string]$Version
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$uiRoot = Join-Path $projectRoot "ui"
$tauriRoot = Join-Path $projectRoot "src-tauri"
$pythonIpcRoot = Join-Path $projectRoot "python\portal\ipc"
$pythonDataRoot = Join-Path $projectRoot "python\portal\data"
$cargo = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"

if (-not $Version) {
    $Version = (Get-Content -LiteralPath (Join-Path $tauriRoot "tauri.conf.json") -Raw | ConvertFrom-Json).version
}
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
    throw "Version must be a semantic version, for example 0.2.0."
}

if (-not $PythonExecutable) {
    $portalCondaPython = Join-Path $env:USERPROFILE "AppData\Local\miniconda3\envs\portal\python.exe"
    $legacyCondaPython = Join-Path $env:USERPROFILE "AppData\Local\miniconda3\envs\arf\python.exe"
    $PythonExecutable = if (Test-Path -LiteralPath $portalCondaPython -PathType Leaf) {
        $portalCondaPython
    } elseif (Test-Path -LiteralPath $legacyCondaPython -PathType Leaf) {
        $legacyCondaPython
    } else {
        "python"
    }
}

$defaultOutputDirectory = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "dist\Portal-Desktop"))
if ($OutputDirectory) {
    $requestedOutputDirectory = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
        [System.IO.Path]::GetFullPath($OutputDirectory)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputDirectory))
    }
    if ($requestedOutputDirectory -ne $defaultOutputDirectory) {
        throw "Portal Desktop builds must use the standard output directory: $defaultOutputDirectory"
    }
}
$OutputDirectory = $defaultOutputDirectory
if (-not $SystemDatabase) {
    $SystemDatabase = Join-Path $projectRoot "portal-manager\dist\Portal-Manager\config\system.db"
}
$SystemDatabase = [System.IO.Path]::GetFullPath($SystemDatabase)
if (-not (Test-Path -LiteralPath $SystemDatabase -PathType Leaf)) {
    throw "The authoritative Portal Manager system database was not found at $SystemDatabase."
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$outputPrefix = $OutputDirectory.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$existingSettingsPath = Join-Path $OutputDirectory "config\portal.settings.json"
$settingsTemplatePath = Join-Path $projectRoot "desktop\config\desktop-config.template.json"
$projectConfigSourcePath = Join-Path $projectRoot "desktop\config\project.toml"
$removePortalSourcePath = Join-Path $projectRoot "desktop\release\Remove-Portal.bat"
$settingsRecoveryPath = Join-Path ([System.IO.Path]::GetTempPath()) "Portal-Desktop.portal.settings.json"
$existingSettings = if (Test-Path -LiteralPath $existingSettingsPath -PathType Leaf) {
    $settingsText = Get-Content -LiteralPath $existingSettingsPath -Raw
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($settingsRecoveryPath, $settingsText, $utf8WithoutBom)
    $settingsText
} elseif (Test-Path -LiteralPath $settingsRecoveryPath -PathType Leaf) {
    Get-Content -LiteralPath $settingsRecoveryPath -Raw
} else {
    $null
}

if (-not (Test-Path -LiteralPath $cargo -PathType Leaf)) {
    throw "Cargo was not found at $cargo. Install the Rust MSVC toolchain before building."
}
if (-not (Test-Path -LiteralPath $projectConfigSourcePath -PathType Leaf)) {
    throw "The packaged map project configuration was not found at $projectConfigSourcePath."
}
if (-not (Test-Path -LiteralPath $removePortalSourcePath -PathType Leaf)) {
    throw "The Portal removal script was not found at $removePortalSourcePath."
}
$templateSettings = Get-Content -LiteralPath $settingsTemplatePath -Raw | ConvertFrom-Json
$cacheBackedPaths = @(
    $templateSettings.risk.databases.PSObject.Properties.Value
    $templateSettings.assetHistory.sources.PSObject.Properties | ForEach-Object { $_.Value.database }
    $templateSettings.dataSources.PSObject.Properties | ForEach-Object {
        $accessModeProperty = $_.Value.PSObject.Properties["accessMode"]
        $accessMode = if ($null -ne $accessModeProperty) { [string]$accessModeProperty.Value } else { "" }
        if ($accessMode -ne "direct-network") {
            $databaseProperty = $_.Value.PSObject.Properties["database"]
            $manifestProperty = $_.Value.PSObject.Properties["manifest"]
            if ($null -ne $databaseProperty) { $databaseProperty.Value }
            if ($null -ne $manifestProperty) { $manifestProperty.Value }
        }
    }
    $templateSettings.aifSources.itpipesIntermediateDatabase
    $templateSettings.aifSources.cityworksIntermediateDatabase
    $templateSettings.aifSources.itpipesProductionDatabase
    $templateSettings.maps.pmtilesRoot
    $templateSettings.maps.legacyPmtilesRoot
    $templateSettings.maps.terrainRoot
    $templateSettings.maps.pmtilesDetailSources.PSObject.Properties | ForEach-Object { $_.Value.database }
    $templateSettings.maps.assetExtractBoundarySources | ForEach-Object { $_.database }
    $templateSettings.maps.duckdbGeoJsonLayers | ForEach-Object { $_.database }
) | Where-Object { $_ }
$sharedCacheFallbacks = @($cacheBackedPaths | Where-Object { [string]$_ -match '\$\{PORTAL_SHARED_DATA_ROOT\}' })
if ($sharedCacheFallbacks.Count -gt 0) {
    throw "Desktop cache-backed database and PMTiles settings must not point to PORTAL_SHARED_DATA_ROOT."
}
$cacheSourceIds = @(
    $templateSettings.system.sourceId
    $templateSettings.risk.databaseSourceIds.PSObject.Properties.Value
    $templateSettings.assetHistory.sources.PSObject.Properties | ForEach-Object { $_.Value.sourceId }
    $templateSettings.dataSources.PSObject.Properties | ForEach-Object {
        $accessModeProperty = $_.Value.PSObject.Properties["accessMode"]
        $accessMode = if ($null -ne $accessModeProperty) { [string]$accessModeProperty.Value } else { "" }
        if ($accessMode -ne "direct-network") {
            $sourceIdProperty = $_.Value.PSObject.Properties["sourceId"]
            if ($null -ne $sourceIdProperty) { $sourceIdProperty.Value }
        }
    }
    $templateSettings.aifSources.itpipesIntermediateSourceId
    $templateSettings.aifSources.cityworksIntermediateSourceId
    $templateSettings.aifSources.itpipesProductionSourceId
    $templateSettings.maps.portalLayerArchiveSources.PSObject.Properties.Value
    $templateSettings.maps.terrainSourceId
    $templateSettings.maps.terrainDemSourceId
    $templateSettings.maps.pmtilesDetailSources.PSObject.Properties | ForEach-Object { $_.Value.databaseSourceId }
    $templateSettings.maps.assetExtractBoundarySources | ForEach-Object { $_.databaseSourceId }
    $templateSettings.maps.duckdbGeoJsonLayers | ForEach-Object { $_.databaseSourceId }
) | Where-Object { $_ } | Sort-Object -Unique
if ($cacheSourceIds.Count -eq 0) {
    throw "Desktop settings do not declare any logical local-cache source IDs."
}
$directNetworkSources = @(
    $templateSettings.dataSources.PSObject.Properties |
        Where-Object {
            $accessModeProperty = $_.Value.PSObject.Properties["accessMode"]
            $null -ne $accessModeProperty -and [string]$accessModeProperty.Value -eq "direct-network"
        }
)
if ($directNetworkSources.Count -ne 1 -or [string]$directNetworkSources[0].Value.sourceId -ne "portal.serving") {
    throw "portal.serving must be the only direct-network Desktop data source."
}
$directNetworkSourceIds = @($templateSettings.dataCache.directNetworkSourceIds)
if ($directNetworkSourceIds -notcontains "portal.serving") {
    throw "dataCache.directNetworkSourceIds must exclude portal.serving from local downloads."
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm is required to build the React UI."
}
if (-not (Get-Command $PythonExecutable -ErrorAction SilentlyContinue)) {
    throw "Python was not found. It is required only on the build workstation."
}

& $PythonExecutable -c "import dotenv, duckdb, geopandas, openpyxl, pandas, pyodbc, pyogrio, pyproj, rasterio, shapely, sqlalchemy"
if ($LASTEXITCODE -ne 0) {
    throw "The selected Python environment is missing Portal runtime dependencies: $PythonExecutable"
}

$duckDbRuntimeInfo = @(& $PythonExecutable -c "import duckdb; c=duckdb.connect(); print(duckdb.__version__); print(c.execute('PRAGMA platform').fetchone()[0])")
if ($LASTEXITCODE -ne 0 -or $duckDbRuntimeInfo.Count -lt 2) {
    throw "Could not determine the bundled DuckDB version and platform."
}
$duckDbVersion = ([string]$duckDbRuntimeInfo[0]).Trim().TrimStart("v")
$duckDbPlatform = ([string]$duckDbRuntimeInfo[1]).Trim()
$duckDbSpatialExtension = Join-Path $env:USERPROFILE ".duckdb\extensions\v$duckDbVersion\$duckDbPlatform\spatial.duckdb_extension"
if (-not (Test-Path -LiteralPath $duckDbSpatialExtension -PathType Leaf)) {
    Write-Host "Installing the signed DuckDB spatial extension on the build workstation..."
    & $PythonExecutable -c "import duckdb; c=duckdb.connect(); c.install_extension('spatial')"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $duckDbSpatialExtension -PathType Leaf)) {
        throw "DuckDB spatial $duckDbVersion for $duckDbPlatform was not found at $duckDbSpatialExtension. The full portable release cannot be built without its offline spatial runtime."
    }
}
$env:PORTAL_BUILD_SPATIAL_EXTENSION = $duckDbSpatialExtension
try {
    & $PythonExecutable -c "import os, duckdb; c=duckdb.connect(); c.execute('SET autoinstall_known_extensions=false'); c.execute('SET autoload_known_extensions=false'); c.load_extension(os.environ['PORTAL_BUILD_SPATIAL_EXTENSION']); assert c.execute('SELECT ST_AsText(ST_Point(1, 2))').fetchone()[0] == 'POINT (1 2)'"
    if ($LASTEXITCODE -ne 0) {
        throw "The local DuckDB spatial extension is incompatible with the selected Python runtime."
    }
}
finally {
    Remove-Item Env:PORTAL_BUILD_SPATIAL_EXTENSION -ErrorAction SilentlyContinue
}

Write-Host "[1/4] Building React UI..."
& pnpm --dir $uiRoot build
if ($LASTEXITCODE -ne 0) { throw "UI build failed." }

Write-Host "[2/4] Packaging Python worker..."
& $PythonExecutable -m PyInstaller --version *> $null
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller is not installed for $PythonExecutable. Run: $PythonExecutable -m pip install --user pyinstaller"
}

$pythonPrefix = (& $PythonExecutable -c "import sys; print(sys.prefix)").Trim()
$pythonLibraryBin = Join-Path $pythonPrefix "Library\bin"
if (Test-Path -LiteralPath $pythonLibraryBin -PathType Container) {
    $env:PATH = "$pythonLibraryBin;$env:PATH"
}

$legacySeed = Join-Path $pythonDataRoot "portal_management.sqlite3"
$systemSeed = Join-Path $pythonDataRoot "portal_system.sqlite3"
if (-not (Test-Path -LiteralPath $legacySeed -PathType Leaf)) {
    throw "The source management database seed was not found at $legacySeed."
}
Push-Location (Join-Path $projectRoot "python")
try {
    & $PythonExecutable -m portal.app.business.seed `
        --source $legacySeed `
        --system $systemSeed
    if ($LASTEXITCODE -ne 0) { throw "Desktop database seed separation failed." }

    $previousSystemDatabase = $env:PORTAL_SYSTEM_DB
    try {
        $env:PORTAL_SYSTEM_DB = $systemSeed
        & $PythonExecutable -c "from portal.app.management.seed import initialize_management_database; initialize_management_database()"
        if ($LASTEXITCODE -ne 0) { throw "Desktop system database initialization failed." }
    }
    finally {
        if ($null -eq $previousSystemDatabase) {
            Remove-Item Env:PORTAL_SYSTEM_DB -ErrorAction SilentlyContinue
        } else {
            $env:PORTAL_SYSTEM_DB = $previousSystemDatabase
        }
    }
}
finally {
    Pop-Location
}

$pythonDist = Join-Path $pythonIpcRoot "dist"
$pythonBuild = Join-Path $pythonIpcRoot "build"
New-Item -ItemType Directory -Force -Path $pythonDist, $pythonBuild | Out-Null
& $PythonExecutable -m PyInstaller `
    --noconfirm `
    --clean `
    --onedir `
    --name portal-python `
    --distpath $pythonDist `
    --workpath $pythonBuild `
    --specpath $pythonBuild `
    --paths (Join-Path $projectRoot "python") `
    --collect-submodules portal `
    --collect-submodules pyproj `
    --collect-submodules rasterio `
    --collect-submodules shapely `
    --collect-all pytz `
    --collect-all pyogrio `
    --add-data "$pythonPrefix\Library\share\gdal;Library\share\gdal" `
    --add-data "$projectRoot\python\portal\app\config;portal\app\config" `
    --add-data "$projectRoot\python\portal\app\resources\maps\stm_risk_map\assets;portal\app\resources\maps\stm_risk_map\assets" `
    --add-data "$systemSeed;portal\data" `
    --add-data "$projectRoot\python\portal\environment.yml;portal" `
    --add-data "$uiRoot\src\resources;portal\resource_metadata" `
    (Join-Path $pythonIpcRoot "portal_worker.py")
if ($LASTEXITCODE -ne 0) { throw "Python worker packaging failed." }

Write-Host "[3/4] Building Tauri host..."
$previousPackageVersion = $env:PORTAL_PACKAGE_VERSION
try {
    $env:PORTAL_PACKAGE_VERSION = $Version
    & $cargo build `
        --release `
        --features custom-protocol `
        --bin Portal `
        --bin PortalUpdater `
        --manifest-path (Join-Path $tauriRoot "Cargo.toml")
    if ($LASTEXITCODE -ne 0) { throw "Tauri build failed." }
}
finally {
    if ($null -eq $previousPackageVersion) {
        Remove-Item Env:PORTAL_PACKAGE_VERSION -ErrorAction SilentlyContinue
    }
    else {
        $env:PORTAL_PACKAGE_VERSION = $previousPackageVersion
    }
}

Write-Host "[4/4] Assembling portable folder..."
$outputRoot = [System.IO.Path]::GetPathRoot($OutputDirectory)
if (
    $OutputDirectory -eq $projectRoot -or
    $OutputDirectory -eq $outputRoot -or
    $OutputDirectory.Length -le $outputRoot.Length
) {
    throw "Refusing to replace unsafe portable output path: $OutputDirectory"
}
if (Test-Path -LiteralPath $OutputDirectory -PathType Container) {
    Remove-Item -LiteralPath $OutputDirectory -Recurse -Force
}
$configOutput = Join-Path $OutputDirectory "config"
$runtimeOutput = Join-Path $OutputDirectory "runtime"
$duckDbExtensionOutput = Join-Path $runtimeOutput "duckdb\extensions"
New-Item -ItemType Directory -Force -Path `
    $OutputDirectory, $configOutput, $runtimeOutput, $duckDbExtensionOutput | Out-Null

$portalExecutable = Join-Path $tauriRoot "target\release\Portal.exe"
$portalUpdaterExecutable = Join-Path $tauriRoot "target\release\PortalUpdater.exe"
$pythonWorkerDirectory = Join-Path $pythonDist "portal-python"
$pythonWorker = Join-Path $pythonWorkerDirectory "portal-python.exe"
if (-not (Test-Path -LiteralPath $portalExecutable -PathType Leaf)) {
    throw "Portal.exe was not produced at $portalExecutable."
}
if (-not (Test-Path -LiteralPath $portalUpdaterExecutable -PathType Leaf)) {
    throw "PortalUpdater.exe was not produced at $portalUpdaterExecutable."
}
if (-not (Test-Path -LiteralPath $pythonWorkerDirectory -PathType Container) -or -not (Test-Path -LiteralPath $pythonWorker -PathType Leaf)) {
    throw "portal-python.exe was not produced at $pythonWorker."
}

Copy-Item -LiteralPath $portalExecutable -Destination (Join-Path $OutputDirectory "Portal.exe") -Force
Copy-Item -LiteralPath $removePortalSourcePath -Destination (Join-Path $OutputDirectory "Remove-Portal.bat") -Force
Copy-Item -LiteralPath $pythonWorkerDirectory -Destination (Join-Path $runtimeOutput "portal-python") -Recurse -Force
Copy-Item -LiteralPath $portalUpdaterExecutable -Destination (Join-Path $runtimeOutput "PortalUpdater.exe") -Force
Copy-Item -LiteralPath $duckDbSpatialExtension -Destination (Join-Path $duckDbExtensionOutput "spatial.duckdb_extension") -Force
$settingsOutput = Join-Path $configOutput "portal.settings.json"
if ($null -ne $existingSettings) {
    $existingSettingsObject = $existingSettings | ConvertFrom-Json
    $templateSettingsObject = Get-Content -LiteralPath $settingsTemplatePath -Raw | ConvertFrom-Json
    $existingSettingsObject | Add-Member -MemberType NoteProperty -Name dataCache -Value $templateSettingsObject.dataCache -Force
    $existingSettingsObject | Add-Member -MemberType NoteProperty -Name system -Value $templateSettingsObject.system -Force
    $existingSettingsObject | Add-Member -MemberType NoteProperty -Name risk -Value $templateSettingsObject.risk -Force
    $existingSettingsObject | Add-Member -MemberType NoteProperty -Name assetHistory -Value $templateSettingsObject.assetHistory -Force
    $existingSettingsObject | Add-Member -MemberType NoteProperty -Name dataSources -Value $templateSettingsObject.dataSources -Force
    $existingSettingsObject | Add-Member -MemberType NoteProperty -Name aifSources -Value $templateSettingsObject.aifSources -Force
    $existingSettingsObject | Add-Member -MemberType NoteProperty -Name maps -Value $templateSettingsObject.maps -Force
    if ($null -ne $existingSettingsObject.externalServices.cityworks) {
        $existingSettingsObject.externalServices.cityworks | Add-Member `
            -MemberType NoteProperty `
            -Name requestUrlTemplate `
            -Value $templateSettingsObject.externalServices.cityworks.requestUrlTemplate `
            -Force
    }
    if ($null -ne $existingSettingsObject.risk -and $null -ne $existingSettingsObject.risk.databases) {
        $existingSettingsObject.risk.databases.PSObject.Properties.Remove("mapRisk")
    }
    if ($null -ne $existingSettingsObject.externalServices.maps) {
        @(
            "ncOneMapImageryServiceRoot",
            "ncOneMapAcquisitionMapServer",
            "usgsTopoTileUrl",
            "usgsImageryTopoTileUrl"
        ) | ForEach-Object {
            $existingSettingsObject.externalServices.maps.PSObject.Properties.Remove($_)
        }
    }
    $existingSettings = $existingSettingsObject | ConvertTo-Json -Depth 100
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($settingsOutput, $existingSettings, $utf8WithoutBom)
    Remove-Item -LiteralPath $settingsRecoveryPath -Force -ErrorAction SilentlyContinue
} else {
    Copy-Item -LiteralPath $settingsTemplatePath -Destination $settingsOutput -Force
}
Copy-Item -LiteralPath $projectConfigSourcePath -Destination (Join-Path $configOutput "project.toml") -Force
$packagedSystemDatabase = Join-Path $configOutput "system.db"
Copy-Item -LiteralPath $SystemDatabase -Destination $packagedSystemDatabase -Force
Set-ItemProperty -LiteralPath $packagedSystemDatabase -Name IsReadOnly -Value $true

$version = $Version
Set-Content -LiteralPath (Join-Path $OutputDirectory "VERSION") -Value $version -Encoding ascii
@"
Storm Water Asset Intelligence Portal Desktop $version

Run Portal.exe from this local folder. No local service or installer is required.
Writable application data is stored under %LOCALAPPDATA%\StormWaterPortal\data. At startup,
the application checks the shared publication manifest and activates verified read-only
system catalog, DuckDB, PMTiles, and terrain files in its local versioned source cache.
The frequently refreshed portal.serving SQLite snapshot is the only direct-network
source and is resolved through its atomic G-drive manifest. All other resources read
active local versions. The map project catalog is
packaged as config\project.toml, while map styles and sprites are packaged with
the map resource.

Business snapshots, submissions, and conflict packages use the businessSync network
root in config\portal.settings.json. Portal.exe never opens a writable SQLite
connection on that network share. The active shared protocol snapshot is verified and
copied locally on first use; no business database is included in this portable folder.

The desktop application uses Tauri IPC and local Python commands. It does not start
FastAPI, expose REST endpoints, or require a localhost service.
"@ | Set-Content -LiteralPath (Join-Path $OutputDirectory "README.txt") -Encoding ascii

$manifestPath = Join-Path $OutputDirectory "manifest.json"
$manifest = Get-ChildItem -LiteralPath $OutputDirectory -File -Recurse |
    Where-Object { $_.FullName -ne $manifestPath } |
    ForEach-Object {
    [ordered]@{
        path = $_.FullName.Substring($outputPrefix.Length)
        size = $_.Length
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8

Write-Host "Portable folder ready: $OutputDirectory"
