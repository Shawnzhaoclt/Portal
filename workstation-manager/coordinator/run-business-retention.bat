@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Runs the configured automatic business-data retention check once.
rem The Python coordinator verifies snapshot coverage and copies before it
rem publishes a new log floor or removes an online operation package.

set "COORDINATOR_DIRECTORY=%~dp0"
set "MANAGER_ROOT=%COORDINATOR_DIRECTORY%.."
set "MANAGER_SETTINGS=%MANAGER_ROOT%\config\workstation-manager.settings.json"
set "RUNNER=%COORDINATOR_DIRECTORY%maintenance_runner.py"

if not exist "%MANAGER_SETTINGS%" (
  echo ERROR: Workstation Manager settings were not found: %MANAGER_SETTINGS%
  exit /b 1
)
if not exist "%RUNNER%" (
  echo ERROR: Business retention runner was not found: %RUNNER%
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

"%PYTHON_EXE%" "%RUNNER%" --task snapshot.retention.run --portal-settings "%PORTAL_SETTINGS%" --automatic
exit /b %ERRORLEVEL%
