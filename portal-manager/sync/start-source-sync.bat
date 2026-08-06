@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Starts the same scheduled worker used by Portal Workstation Manager.
rem The Python worker owns a named Windows mutex, so duplicate launches are rejected.

set "SYNC_DIRECTORY=%~dp0"
set "CONFIG_FILE=%SYNC_DIRECTORY%sync.settings.json"
set "SYNC_SCRIPT=%SYNC_DIRECTORY%sync_portal_sources.py"

if not exist "%CONFIG_FILE%" (
  echo ERROR: Sync configuration was not found:
  echo %CONFIG_FILE%
  exit /b 1
)

if not exist "%SYNC_SCRIPT%" (
  echo ERROR: Sync worker was not found:
  echo %SYNC_SCRIPT%
  exit /b 1
)

rem PORTAL_SYNC_PYTHON overrides the configured runtime for approved deployments.
if defined PORTAL_SYNC_PYTHON (
  set "PYTHON_EXE=%PORTAL_SYNC_PYTHON%"
) else (
  for /f "tokens=1,* delims=:" %%A in ('findstr /i /c:"pythonExecutable" "%CONFIG_FILE%"') do set "PYTHON_VALUE=%%B"
  set "PYTHON_VALUE=!PYTHON_VALUE:"=!"
  set "PYTHON_VALUE=!PYTHON_VALUE:,=!"
  for /f "tokens=*" %%A in ("!PYTHON_VALUE!") do set "PYTHON_EXE=%%A"
)

if not defined PYTHON_EXE set "PYTHON_EXE=python.exe"

"%PYTHON_EXE%" -c "import pyodbc" >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python with pyodbc was not found.
  echo Set PORTAL_SYNC_PYTHON or update pythonExecutable in sync.settings.json.
  exit /b 1
)

start "Portal source data sync" /b "%PYTHON_EXE%" "%SYNC_SCRIPT%" --config "%CONFIG_FILE%" --schedule --non-interactive
if errorlevel 1 (
  echo ERROR: Unable to start the source data scheduler.
  exit /b 1
)

echo The Portal source data scheduler was started.
echo Open Portal Workstation Manager ^> Source Data to monitor it.
exit /b 0
