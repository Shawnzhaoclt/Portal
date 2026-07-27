@echo off
setlocal
set "RELEASE_ROOT=%~dp0"
if "%RELEASE_ROOT:~-1%"=="\" set "RELEASE_ROOT=%RELEASE_ROOT:~0,-1%"

if not exist "%RELEASE_ROOT%\PortalUpdater.exe" (
  echo PortalUpdater.exe was not found beside this downloader.
  pause
  exit /b 1
)

"%RELEASE_ROOT%\PortalUpdater.exe" --bootstrap --manifest "portal-bootstrap.json" --release-root "%RELEASE_ROOT%" --restart
if errorlevel 1 (
  echo.
  echo Portal download failed. Review the message above and contact the Portal developer if the issue continues.
  pause
  exit /b 1
)

echo.
echo Storm Water Asset Intelligence Portal is ready to use.
echo A Desktop shortcut has been created and Portal is starting.
msg "%USERNAME%" "Storm Water Asset Intelligence Portal is ready to use." >nul 2>&1
