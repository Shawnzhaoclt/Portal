@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "BACKEND_PORT=8000"
set "FRONTEND_PORT=5173"
set "LAN_HOST=10.40.68.23"
set "PUBLIC_FRONTEND_URL=http://%LAN_HOST%:%FRONTEND_PORT%"
set "LOCAL_FRONTEND_URL=http://127.0.0.1:%FRONTEND_PORT%"
set "BACKEND_URL=http://127.0.0.1:%BACKEND_PORT%"
set "CONDA_ENV=portal"
set "CONDA_BAT=%USERPROFILE%\AppData\Local\miniconda3\condabin\conda.bat"
set "BACKEND_LOG=%ROOT%\backend\app\api.log"
set "BACKEND_ERR=%ROOT%\backend\app\api.err.log"
set "FRONTEND_DIR=%ROOT%\frontend"
set "FRONTEND_LOG_DIR=%FRONTEND_DIR%\logs"
set "FRONTEND_LOG=%FRONTEND_LOG_DIR%\vite.log"
set "FRONTEND_ERR=%FRONTEND_LOG_DIR%\vite.err.log"
set "NO_PAUSE=0"
set "CONDA_AVAILABLE=0"

if not exist "%FRONTEND_LOG_DIR%" mkdir "%FRONTEND_LOG_DIR%" >nul 2>nul

if /I "%~1"=="/nopause" set "NO_PAUSE=1"

if exist "%CONDA_BAT%" set "CONDA_AVAILABLE=1"
if "%CONDA_AVAILABLE%"=="0" if exist "%USERPROFILE%\miniconda3\condabin\conda.bat" (
  set "CONDA_BAT=%USERPROFILE%\miniconda3\condabin\conda.bat"
  set "CONDA_AVAILABLE=1"
)
if "%CONDA_AVAILABLE%"=="0" if exist "%ProgramData%\miniconda3\condabin\conda.bat" (
  set "CONDA_BAT=%ProgramData%\miniconda3\condabin\conda.bat"
  set "CONDA_AVAILABLE=1"
)
if "%CONDA_AVAILABLE%"=="0" (
  for /F "delims=" %%C in ('where conda.bat 2^>nul') do (
    set "CONDA_BAT=%%C"
    set "CONDA_AVAILABLE=1"
  )
)

echo.
echo ==========================================
echo  Storm Water Asset Intelligence Portal
echo  service launcher
echo ==========================================
echo Project root: %ROOT%
echo Portal:       %PUBLIC_FRONTEND_URL%/
echo.

echo Checking current service status...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$name='Backend API'; $port=%BACKEND_PORT%; $listeners=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if ($listeners) { $processIds=$listeners | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($processId in $processIds) { $proc=Get-Process -Id $processId -ErrorAction SilentlyContinue; $procName=if ($proc) { $proc.ProcessName } else { 'unknown' }; Write-Host ('[RUNNING] {0} port {1} PID {2} ({3})' -f $name,$port,$processId,$procName) }; exit 0 } else { Write-Host ('[STOPPED] {0} port {1}' -f $name,$port); exit 1 }"
if errorlevel 1 (
  set "BACKEND_RUNNING=0"
) else (
  set "BACKEND_RUNNING=1"
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$name='Frontend Vite'; $port=%FRONTEND_PORT%; $listeners=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if ($listeners) { $processIds=$listeners | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($processId in $processIds) { $proc=Get-Process -Id $processId -ErrorAction SilentlyContinue; $procName=if ($proc) { $proc.ProcessName } else { 'unknown' }; Write-Host ('[RUNNING] {0} port {1} PID {2} ({3})' -f $name,$port,$processId,$procName) }; exit 0 } else { Write-Host ('[STOPPED] {0} port {1}' -f $name,$port); exit 1 }"
if errorlevel 1 (
  set "FRONTEND_RUNNING=0"
) else (
  set "FRONTEND_RUNNING=1"
)

echo.

if "%BACKEND_RUNNING%"=="0" (
  echo Starting Backend API on port %BACKEND_PORT%...
  if "%CONDA_AVAILABLE%"=="0" (
    echo [ERROR] Miniconda/Conda was not found. Install Miniconda or update CONDA_BAT in this file.
  ) else (
    echo Using Conda: %CONDA_BAT%
    call "%CONDA_BAT%" run -n "!CONDA_ENV!" python -c "import uvicorn" >nul 2>nul
    if errorlevel 1 if /I not "!CONDA_ENV!"=="arf" (
      echo [WARN] Conda environment "!CONDA_ENV!" was not found or cannot import uvicorn.
      echo [WARN] Trying legacy Conda environment "arf".
      set "CONDA_ENV=arf"
      call "%CONDA_BAT%" run -n "!CONDA_ENV!" python -c "import uvicorn" >nul 2>nul
    )
    if errorlevel 1 (
      echo [ERROR] Conda environment "!CONDA_ENV!" was not found or cannot import uvicorn.
      call "%CONDA_BAT%" env list
      echo [ERROR] Conda environment "!CONDA_ENV!" is not ready. Backend API was not started.
    ) else (
      echo [OK] Conda environment "!CONDA_ENV!" is ready.
      powershell -NoProfile -ExecutionPolicy Bypass -Command "$quote=[char]34; $cmd='set PORTAL_DEFAULT_FRONTEND_BASE_URL=%PUBLIC_FRONTEND_URL%&& set PORTAL_PUBLIC_FRONTEND_BASE_URL=%PUBLIC_FRONTEND_URL%&& ' + $quote + '%CONDA_BAT%' + $quote + ' run -n !CONDA_ENV! uvicorn backend.app.api:app --host 0.0.0.0 --port %BACKEND_PORT%'; Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/c',$cmd) -WorkingDirectory '%ROOT%' -RedirectStandardOutput '%BACKEND_LOG%' -RedirectStandardError '%BACKEND_ERR%' -WindowStyle Hidden"
      powershell -NoProfile -ExecutionPolicy Bypass -Command "$name='Backend API'; $port=%BACKEND_PORT%; $ok=$false; for ($i=0; $i -lt 30; $i++) { if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $ok=$true; break }; Start-Sleep -Seconds 1 }; if ($ok) { Write-Host ('[OK] {0} is listening on port {1}.' -f $name,$port); exit 0 } else { Write-Host ('[WARN] {0} did not start listening on port {1} within 30 seconds.' -f $name,$port); exit 1 }"
    )
  )
) else (
  echo Backend API is already running. No start needed.
)

echo.

if "%FRONTEND_RUNNING%"=="0" (
  echo Starting Frontend Vite on port %FRONTEND_PORT%...
  set "FRONTEND_MANAGER="
  set "FRONTEND_INSTALL_CMD="
  set "FRONTEND_DEV_CMD="
  where pnpm >nul 2>nul
  if not errorlevel 1 (
    set "FRONTEND_MANAGER=pnpm"
    set "FRONTEND_INSTALL_CMD=pnpm install --frozen-lockfile"
    set "FRONTEND_DEV_CMD=pnpm run dev -- --host 0.0.0.0 --port %FRONTEND_PORT% --strictPort"
  ) else (
    where npm >nul 2>nul
    if not errorlevel 1 (
      set "FRONTEND_MANAGER=npm"
      set "FRONTEND_INSTALL_CMD=npm install"
      set "FRONTEND_DEV_CMD=npm run dev -- --host 0.0.0.0 --port %FRONTEND_PORT% --strictPort"
    )
  )

  if not defined FRONTEND_MANAGER (
    echo [ERROR] pnpm/npm was not found on PATH. Install Node.js or add a package manager to PATH, then retry.
  ) else (
    if not exist "%FRONTEND_DIR%\node_modules\vite\bin\vite.js" (
      echo Frontend dependencies are missing or stale. Running !FRONTEND_INSTALL_CMD!...
      pushd "%FRONTEND_DIR%"
      set "CI=true"
      call !FRONTEND_INSTALL_CMD!
      set "FRONTEND_INSTALL_EXIT=!errorlevel!"
      popd
      if not "!FRONTEND_INSTALL_EXIT!"=="0" (
        echo [ERROR] Frontend dependency install failed. Frontend Vite was not started.
      )
    )

    if exist "%FRONTEND_DIR%\node_modules\vite\bin\vite.js" (
      powershell -NoProfile -ExecutionPolicy Bypass -Command "$cmd='!FRONTEND_DEV_CMD!'; Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/c',$cmd) -WorkingDirectory '%FRONTEND_DIR%' -RedirectStandardOutput '%FRONTEND_LOG%' -RedirectStandardError '%FRONTEND_ERR%' -WindowStyle Hidden"
      powershell -NoProfile -ExecutionPolicy Bypass -Command "$name='Frontend Vite'; $port=%FRONTEND_PORT%; $ok=$false; for ($i=0; $i -lt 30; $i++) { if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $ok=$true; break }; Start-Sleep -Seconds 1 }; if ($ok) { Write-Host ('[OK] {0} is listening on port {1}.' -f $name,$port); exit 0 } else { Write-Host ('[WARN] {0} did not start listening on port {1} within 30 seconds.' -f $name,$port); exit 1 }"
    ) else (
      echo [ERROR] Vite is still missing after dependency install. Frontend Vite was not started.
    )
  )
) else (
  echo Frontend Vite is already running. No start needed.
)

echo.
echo Final service status:
set "SERVICE_ERROR=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$name='Backend API'; $port=%BACKEND_PORT%; $listeners=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if ($listeners) { $processIds=$listeners | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($processId in $processIds) { $proc=Get-Process -Id $processId -ErrorAction SilentlyContinue; $procName=if ($proc) { $proc.ProcessName } else { 'unknown' }; Write-Host ('[RUNNING] {0} port {1} PID {2} ({3})' -f $name,$port,$processId,$procName) }; exit 0 } else { Write-Host ('[STOPPED] {0} port {1}' -f $name,$port); exit 1 }"
if errorlevel 1 set "SERVICE_ERROR=1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$name='Frontend Vite'; $port=%FRONTEND_PORT%; $listeners=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if ($listeners) { $processIds=$listeners | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($processId in $processIds) { $proc=Get-Process -Id $processId -ErrorAction SilentlyContinue; $procName=if ($proc) { $proc.ProcessName } else { 'unknown' }; Write-Host ('[RUNNING] {0} port {1} PID {2} ({3})' -f $name,$port,$processId,$procName) }; exit 0 } else { Write-Host ('[STOPPED] {0} port {1}' -f $name,$port); exit 1 }"
if errorlevel 1 set "SERVICE_ERROR=1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$name='Backend health'; $url='%BACKEND_URL%/health'; try { $response=Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3; Write-Host ('[OK] {0}: HTTP {1}' -f $name,[int]$response.StatusCode); exit 0 } catch { Write-Host ('[WARN] {0}: {1}' -f $name,$_.Exception.Message); exit 1 }"
if errorlevel 1 set "SERVICE_ERROR=1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$name='Portal home'; $url='%LOCAL_FRONTEND_URL%/'; try { $response=Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5; Write-Host ('[OK] {0}: HTTP {1}' -f $name,[int]$response.StatusCode); exit 0 } catch { Write-Host ('[WARN] {0}: {1}' -f $name,$_.Exception.Message); exit 1 }"
if errorlevel 1 set "SERVICE_ERROR=1"

echo.
echo URLs:
echo   Portal home:              %PUBLIC_FRONTEND_URL%/
echo   Local portal home:        %LOCAL_FRONTEND_URL%/
echo   Dashboard links:          %PUBLIC_FRONTEND_URL%/dashboard_links
echo   Portal management:        %PUBLIC_FRONTEND_URL%/admin_management
echo   Dashboard catalog API:    %BACKEND_URL%/api/dashboards
echo   Critical Team:            %PUBLIC_FRONTEND_URL%/dashboard_critical_team
echo   Critical Asset Tracking:  %PUBLIC_FRONTEND_URL%/dashboard_critical_asset_tracking
echo   Critical Asset Facility:  %PUBLIC_FRONTEND_URL%/map_critical_asset_facility
echo   Critical Asset History:   %PUBLIC_FRONTEND_URL%/map_critical_asset_history
echo   STM Risk Map:             %PUBLIC_FRONTEND_URL%/map_stm_risk
echo   Backend health:           %BACKEND_URL%/health
echo.
echo Logs:
echo   Backend stdout:  %BACKEND_LOG%
echo   Backend stderr:  %BACKEND_ERR%
echo   Frontend stdout: %FRONTEND_LOG%
echo   Frontend stderr: %FRONTEND_ERR%
echo.

if "%SERVICE_ERROR%"=="0" (
  echo All services are running. Closing this window...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 2"
  exit /b 0
)

echo One or more services failed. Review the status and log paths above.
if "%NO_PAUSE%"=="0" pause
exit /b 1
