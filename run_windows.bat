@echo off
chcp 65001 >nul
REM Inksync launcher (Windows) - checks requirements, then starts the server.
REM Keep this file next to server.py. Persian UI text lives in lang\*.txt
REM (printed via "type", never inline in this file) because cmd.exe parses
REM the .bat source using the legacy OEM codepage regardless of chcp,
REM which corrupts inline non-ASCII text.

setlocal EnableExtensions
cd /d "%~dp0"

set "VENV=.venv"
set "PY="

if exist "%VENV%\Scripts\python.exe" set "PY=%VENV%\Scripts\python.exe"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)
if not defined PY (
    where py >nul 2>nul && set "PY=py"
)
if defined PY goto :havepython

echo [FAIL] Python 3 was not found on this system.
echo        Install it from https://www.python.org/downloads/
echo        IMPORTANT: tick "Add python.exe to PATH" in the installer.
if exist "lang\no_python.txt" type "lang\no_python.txt"
goto :end

:havepython
echo Checking requirements for Inksync...
if exist "lang\checking.txt" type "lang\checking.txt"
"%PY%" preflight.py --root "%cd%"
set "RC=%errorlevel%"

if "%RC%"=="0" goto :run
if "%RC%"=="2" goto :offerinstall
if "%RC%"=="9009" (
    echo   Hint: this can be the fake "python.exe" from the Microsoft Store.
    echo   Turn OFF Settings ^> Apps ^> App execution aliases, or install real Python.
)
goto :abort

:offerinstall
echo.
set "ANSWER="
set /p "ANSWER=Install the missing package now? (creates a private .venv - needs internet) [y/N] "
if /i "%ANSWER%"=="y" goto :doinstall
if /i "%ANSWER%"=="yes" goto :doinstall

echo Install it manually, then run this file again:
echo     "%PY%" -m pip install aiohttp
if exist "lang\install_manually.txt" type "lang\install_manually.txt"
goto :end

:doinstall
echo.
echo Creating virtual environment (.venv)...
"%PY%" -m venv "%VENV%"
if errorlevel 1 (
    echo [FAIL] Could not create the virtual environment.
    echo        Try manually:  "%PY%" -m pip install aiohttp
    if exist "lang\venv_fail.txt" type "lang\venv_fail.txt"
    goto :end
)
echo Installing aiohttp...
"%VENV%\Scripts\python.exe" -m pip install aiohttp
if errorlevel 1 (
    echo [FAIL] Installing aiohttp did not succeed - check your internet connection.
    if exist "lang\aiohttp_fail.txt" type "lang\aiohttp_fail.txt"
    goto :end
)
"%VENV%\Scripts\python.exe" preflight.py --root "%cd%"
if errorlevel 1 goto :end
set "PY=%VENV%\Scripts\python.exe"
goto :run

:abort
echo.
echo [ABORTED] Fix the problem(s) listed above, then run this file again.
if exist "lang\abort.txt" type "lang\abort.txt"
goto :end

:run
echo.
echo Starting Inksync server on http://localhost:8765/   (Ctrl-C to stop)
if exist "lang\ctrlc.txt" type "lang\ctrlc.txt"
"%PY%" server.py
set "RC=%errorlevel%"
echo.
if "%RC%"=="0" (
    echo Server stopped.
    if exist "lang\stopped.txt" type "lang\stopped.txt"
) else (
    echo [FAIL] Inksync exited unexpectedly ^(exit code %RC%^).
    echo        The actual error is printed above - scroll up.
    if exist "lang\server_fail.txt" type "lang\server_fail.txt"
)

:end
echo.
pause
