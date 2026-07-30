@echo off
setlocal EnableExtensions

schtasks /Delete /TN "StormWater Portal Business Retention" /F
if errorlevel 1 (
  echo ERROR: The weekly business-retention task was not removed.
  exit /b 1
)

echo The weekly business-retention task was removed.
exit /b 0
