@echo off
rem Stop only this extracted package's verified WorkDaddy lifecycle.
setlocal
if not exist "%~dp0WorkDaddyLauncher.exe" (
  echo ERROR: WorkDaddyLauncher.exe was not found beside this script.
  pause
  exit /b 1
)
"%~dp0WorkDaddyLauncher.exe" --stop-lifecycle --app-dir "%~dp0"
if errorlevel 1 (
  echo ERROR: Could not stop this package's WorkDaddy lifecycle. Close WorkBuddy and retry.
  pause
  exit /b 1
)
echo WorkDaddy stopped. Account data was not deleted.
