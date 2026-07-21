[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [string]$PythonExecutable
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

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $projectRoot "dist\Portal-Desktop"
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$outputPrefix = $OutputDirectory.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$existingSettingsPath = Join-Path $OutputDirectory "config\portal.settings.json"
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
$businessSeed = Join-Path $pythonDataRoot "portal_business.sqlite3"
if (-not (Test-Path -LiteralPath $legacySeed -PathType Leaf)) {
    throw "The source management database seed was not found at $legacySeed."
}
Push-Location (Join-Path $projectRoot "python")
try {
    & $PythonExecutable -m portal.app.business.seed `
        --source $legacySeed `
        --system $systemSeed `
        --business $businessSeed
    if ($LASTEXITCODE -ne 0) { throw "Desktop database seed separation failed." }
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
    --add-data "$systemSeed;portal\data" `
    --add-data "$businessSeed;portal\data" `
    --add-data "$projectRoot\python\portal\environment.yml;portal" `
    --add-data "$uiRoot\src\resources;portal\resource_metadata" `
    (Join-Path $pythonIpcRoot "portal_worker.py")
if ($LASTEXITCODE -ne 0) { throw "Python worker packaging failed." }

Write-Host "[3/4] Building Tauri host..."
& $cargo build `
    --release `
    --features custom-protocol `
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
$dataOutput = Join-Path $OutputDirectory "data"
New-Item -ItemType Directory -Force -Path `
    $OutputDirectory, $configOutput, $runtimeOutput, `
    $dataOutput | Out-Null

$portalExecutable = Join-Path $tauriRoot "target\release\Portal.exe"
$pythonWorkerDirectory = Join-Path $pythonDist "portal-python"
$pythonWorker = Join-Path $pythonWorkerDirectory "portal-python.exe"
if (-not (Test-Path -LiteralPath $portalExecutable -PathType Leaf)) {
    throw "Portal.exe was not produced at $portalExecutable."
}
if (-not (Test-Path -LiteralPath $pythonWorkerDirectory -PathType Container) -or -not (Test-Path -LiteralPath $pythonWorker -PathType Leaf)) {
    throw "portal-python.exe was not produced at $pythonWorker."
}

Copy-Item -LiteralPath $portalExecutable -Destination (Join-Path $OutputDirectory "Portal.exe") -Force
Copy-Item -LiteralPath $pythonWorkerDirectory -Destination (Join-Path $runtimeOutput "portal-python") -Recurse -Force
$settingsOutput = Join-Path $configOutput "portal.settings.json"
if ($null -ne $existingSettings) {
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($settingsOutput, $existingSettings, $utf8WithoutBom)
    Remove-Item -LiteralPath $settingsRecoveryPath -Force -ErrorAction SilentlyContinue
} else {
    Copy-Item -LiteralPath (Join-Path $projectRoot "desktop\config\desktop-config.template.json") -Destination $settingsOutput -Force
}
$packagedSystemDatabase = Join-Path $configOutput "system.db"
Copy-Item -LiteralPath $systemSeed -Destination $packagedSystemDatabase -Force
Set-ItemProperty -LiteralPath $packagedSystemDatabase -Name IsReadOnly -Value $true
Copy-Item -LiteralPath $businessSeed -Destination (Join-Path $dataOutput "business.db") -Force

$version = "0.1.0"
Set-Content -LiteralPath (Join-Path $OutputDirectory "VERSION") -Value $version -Encoding ascii
@"
Storm Water Asset Intelligence Portal Desktop $version

Run Portal.exe from this local folder. No local service or installer is required.
Writable application data is stored under %LOCALAPPDATA%\Portal. Published SQLite
source snapshots, read-only risk DuckDB files, PMTiles, map styles, and map
configuration are loaded from the shared data root in config\portal.settings.json
and are not included in this portable folder.

Business master versions, submissions, and conflict packages use the businessSync
network root in config\portal.settings.json. Portal.exe never opens a writable SQLite
connection on that network share. A published master is copied locally on first use.

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
