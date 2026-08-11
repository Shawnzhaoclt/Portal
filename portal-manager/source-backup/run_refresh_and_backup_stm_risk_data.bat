@echo off
setlocal

set "MANAGER_ROOT=%~dp0.."
set "MANAGER_SETTINGS=%MANAGER_ROOT%\config\workstation-manager.settings.json"
set "RUNNER=%MANAGER_ROOT%\coordinator\source_backup_runner.py"
if defined PORTAL_SOURCE_BACKUP_PYTHON (
    set "PYTHON_EXE=%PORTAL_SOURCE_BACKUP_PYTHON%"
) else (
    set "PYTHON_EXE=%LOCALAPPDATA%\miniconda3\envs\stm_env\python.exe"
)

if not exist "%PYTHON_EXE%" (
    echo ERROR: Python executable not found: "%PYTHON_EXE%" 1>&2
    exit /b 1
)

if not exist "%RUNNER%" (
    echo ERROR: Portal Manager source-backup runner not found: "%RUNNER%" 1>&2
    exit /b 1
)

if not exist "%MANAGER_SETTINGS%" (
    echo ERROR: Portal Manager settings not found: "%MANAGER_SETTINGS%" 1>&2
    exit /b 1
)

"%PYTHON_EXE%" "%RUNNER%" --manager-settings "%MANAGER_SETTINGS%" --action workflow
exit /b %ERRORLEVEL%
