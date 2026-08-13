@echo off
setlocal EnableExtensions

echo ============================================================
echo  Remove Storm Water Asset Intelligence Portal
echo ============================================================
echo.
echo WARNING: This will permanently remove ALL Portal application
echo files and ALL locally stored Portal data for your Windows account.
echo.
echo The following will be deleted:
echo   - The Portal Desktop application
echo   - Downloaded DuckDB, SQLite, PMTiles, and terrain data
echo   - Local Portal databases, settings, cache, and exports
echo   - The Storm Water Portal Desktop shortcut
echo.
echo This operation cannot be undone.
echo.

choice /C YN /N /M "Remove the Portal application and all its data? [Y/N]: "
if errorlevel 2 (
  echo.
  echo Removal cancelled. No files were changed.
  exit /b 0
)

if not defined LOCALAPPDATA (
  echo.
  echo Portal could not be removed because LOCALAPPDATA is unavailable.
  pause
  exit /b 1
)

for %%I in ("%LOCALAPPDATA%") do set "LOCAL_ROOT=%%~fI"
for %%I in ("%LOCALAPPDATA%\StormWaterPortal") do set "PORTAL_ROOT=%%~fI"

if not defined LOCAL_ROOT (
  echo.
  echo Portal could not validate the local application-data directory.
  pause
  exit /b 1
)

if /I not "%PORTAL_ROOT%"=="%LOCAL_ROOT%\StormWaterPortal" (
  echo.
  echo Portal refused to remove an unexpected directory:
  echo   %PORTAL_ROOT%
  pause
  exit /b 1
)

echo.
echo Closing Portal processes...
taskkill /IM Portal.exe /F >nul 2>&1
taskkill /IM portal-python.exe /F >nul 2>&1

if exist "%PORTAL_ROOT%\" (
  echo Removing the Portal application and local data...
  rd /S /Q "%PORTAL_ROOT%"
  if exist "%PORTAL_ROOT%\" (
    echo.
    echo Portal could not remove all files from:
    echo   %PORTAL_ROOT%
    echo Close any program using Portal files, then run this script again.
    pause
    exit /b 1
  )
)

if defined USERPROFILE (
  del /F /Q "%USERPROFILE%\Desktop\Storm Water Portal.lnk" >nul 2>&1
)

echo.
echo Storm Water Asset Intelligence Portal and all local Portal data
echo have been removed from this Windows account.
pause
exit /b 0
