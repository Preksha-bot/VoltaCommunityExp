@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-demo.ps1"
if errorlevel 1 (
  echo.
  echo Could not start Volta Pulse. Check the .pulse-local logs in this folder.
  pause
  exit /b 1
)
echo.
echo Open or refresh http://127.0.0.1:5173/ and sign in again.
pause
