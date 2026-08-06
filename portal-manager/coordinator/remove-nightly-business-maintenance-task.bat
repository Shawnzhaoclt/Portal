@echo off
setlocal EnableExtensions

schtasks /Delete /TN "StormWater Portal Nightly Business Maintenance" /F
if errorlevel 1 (
  echo ERROR: The nightly business-maintenance task could not be removed.
  exit /b 1
)
echo Removed "StormWater Portal Nightly Business Maintenance".
exit /b 0
