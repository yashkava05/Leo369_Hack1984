@echo off
rem Latent on Windows: double-click to set up and start the app (backend, frontend, chat page).
rem Flags are passed through, e.g.  scripts\start-windows.cmd -Check   or   -Mock   -AirGap   -Wsl
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1" %*
set LATENT_EXIT=%ERRORLEVEL%
echo.
pause
exit /b %LATENT_EXIT%
