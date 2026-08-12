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
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw "pnpm is required to build the React UI."
}
if (-not (Get-Command $PythonExecutable -ErrorAction SilentlyContinue)) {
    throw "Python was not found. It is required only on the build workstation."
}

& $PythonExecutable -c "import dotenv, duckdb, openpyxl, pandas, pyodbc, sqlalchemy"
if ($LASTEXITCODE -ne 0) {
    throw "The selected Python environment is missing Portal runtime dependencies: $PythonExecutable"
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
    --add-data "$projectRoot\python\portal\app\config;portal\app\config" `
    --add-data "$projectRoot\python\portal\app\resources\maps\stm_risk_map\assets;portal\app\resources\maps\stm_risk_map\assets" `
    --add-data "$systemSeed;portal\data" `
    --add-data "$projectRoot\python\portal\environment.yml;portal" `
    --add-data "$uiRoot\src\resources;portal\resource_metadata" `
    (Join-Path $pythonIpcRoot "portal_worker.py")
if ($LASTEXITCODE -ne 0) { throw "Python worker packaging failed." }

Write-Host "[3/4] Building Tauri host..."
& $cargo build `
    --release `
    --features custom-protocol `
    --bin Portal `
    --bin PortalUpdater `
    --manifest-path (Join-Path $tauriRoot "Cargo.toml")
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed." }

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
New-Item -ItemType Directory -Force -Path `
    $OutputDirectory, $configOutput, $runtimeOutput | Out-Null

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
Copy-Item -LiteralPath $pythonWorkerDirectory -Destination (Join-Path $runtimeOutput "portal-python") -Recurse -Force
Copy-Item -LiteralPath $portalUpdaterExecutable -Destination (Join-Path $runtimeOutput "PortalUpdater.exe") -Force
$settingsOutput = Join-Path $configOutput "portal.settings.json"
if ($null -ne $existingSettings) {
    $existingSettingsObject = $existingSettings | ConvertFrom-Json
    $templateSettingsObject = Get-Content -LiteralPath $settingsTemplatePath -Raw | ConvertFrom-Json
    if ($null -eq $existingSettingsObject.maps) {
        $existingSettingsObject | Add-Member -MemberType NoteProperty -Name maps -Value $templateSettingsObject.maps
    } else {
        $existingSettingsObject.maps | Add-Member -MemberType NoteProperty -Name duckdbGeoJsonLayers -Value $templateSettingsObject.maps.duckdbGeoJsonLayers -Force
        $existingSettingsObject.maps | Add-Member -MemberType NoteProperty -Name terrainRoot -Value $templateSettingsObject.maps.terrainRoot -Force
        $existingSettingsObject.maps | Add-Member -MemberType NoteProperty -Name terrainArchive -Value $templateSettingsObject.maps.terrainArchive -Force
        $existingSettingsObject.maps | Add-Member -MemberType NoteProperty -Name portalLayerArchives -Value $templateSettingsObject.maps.portalLayerArchives -Force
        $existingSettingsObject.maps | Add-Member -MemberType NoteProperty -Name projectConfigFile -Value $templateSettingsObject.maps.projectConfigFile -Force
        $existingSettingsObject.maps.PSObject.Properties.Remove("configurationRoot")
        $existingSettingsObject.maps.PSObject.Properties.Remove("portalLayersArchive")
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
Writable application data is stored under %LOCALAPPDATA%\StormWaterPortal\data. Published SQLite
source snapshots, current read-only risk DuckDB files, and PMTiles are loaded from the
shared data root in config\portal.settings.json. The map project catalog is
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
