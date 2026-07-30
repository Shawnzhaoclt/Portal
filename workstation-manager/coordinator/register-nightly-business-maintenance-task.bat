@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Registers a per-user daily schedule for run-nightly-business-maintenance.bat.

set "COORDINATOR_DIRECTORY=%~dp0"
set "MANAGER_ROOT=%COORDINATOR_DIRECTORY%.."
set "MANAGER_SETTINGS=%MANAGER_ROOT%\config\workstation-manager.settings.json"
set "TASK_NAME=StormWater Portal Nightly Business Maintenance"

if not exist "%MANAGER_SETTINGS%" (
  echo ERROR: Workstation Manager settings were not found: %MANAGER_SETTINGS%
  exit /b 1
)

if defined PORTAL_COORDINATOR_PYTHON (
  set "PYTHON_EXE=%PORTAL_COORDINATOR_PYTHON%"
) else (
  for /f "tokens=1,* delims=:" %%A in ('findstr /i /c:"pythonExecutable" "%MANAGER_SETTINGS%"') do set "PYTHON_VALUE=%%B"
  set "PYTHON_VALUE=!PYTHON_VALUE:"=!"
  set "PYTHON_VALUE=!PYTHON_VALUE:,=!"
  for /f "tokens=*" %%A in ("!PYTHON_VALUE!") do set "PYTHON_EXE=%%A"
  set "PYTHON_EXE=!PYTHON_EXE:${USERPROFILE}=%USERPROFILE%!"
)
if not defined PYTHON_EXE set "PYTHON_EXE=python.exe"

for /f "tokens=1,* delims=:" %%A in ('findstr /i /c:"portalSettingsFile" "%MANAGER_SETTINGS%"') do set "PORTAL_VALUE=%%B"
set "PORTAL_VALUE=!PORTAL_VALUE:"=!"
set "PORTAL_VALUE=!PORTAL_VALUE:,=!"
for /f "tokens=*" %%A in ("!PORTAL_VALUE!") do set "PORTAL_VALUE=%%A"
for %%I in ("%MANAGER_ROOT%\config\!PORTAL_VALUE!") do set "PORTAL_SETTINGS=%%~fI"

if not exist "%PORTAL_SETTINGS%" (
  echo ERROR: Portal settings were not found: %PORTAL_SETTINGS%
  exit /b 1
)

for /f "usebackq delims=" %%A in (`"%PYTHON_EXE%" -c "import json,sys; print(json.load(open(sys.argv[1], encoding='utf-8-sig'))['maintenance']['nightlyBusinessMaintenance']['schedule']['time'])" "%PORTAL_SETTINGS%"`) do set "RUN_TIME=%%A"
if not defined RUN_TIME (
  echo ERROR: Could not read maintenance.nightlyBusinessMaintenance.schedule.time.
  exit /b 1
)

schtasks /Create /TN "%TASK_NAME%" /SC DAILY /ST "%RUN_TIME%" /TR "cmd.exe /d /c \"%COORDINATOR_DIRECTORY%run-nightly-business-maintenance.bat\"" /F
if errorlevel 1 (
  echo ERROR: The nightly business-maintenance task was not registered.
  exit /b 1
)

echo Registered "%TASK_NAME%" for every day at %RUN_TIME%.
exit /b 0
