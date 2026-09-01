@echo off
chcp 65001 >nul
REM Inksync launcher (Windows) — checks requirements, then starts the server.
REM این فایل را کنار server.py نگه دارید — با دابل‌کلیک اجرا می‌شود

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
echo   فارسی: پایتون ۳ نصب نیست — اول آن را نصب کنید.
goto :end

:havepython
echo Checking requirements for Inksync...      بررسی پیش‌نیازها...
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
echo   فارسی: دستی نصب کنید و دوباره اجرا کنید.
goto :end

:doinstall
echo.
echo Creating virtual environment (.venv)...
"%PY%" -m venv "%VENV%"
if errorlevel 1 (
    echo [FAIL] Could not create the virtual environment.
    echo        Try manually:  "%PY%" -m pip install aiohttp
    echo   فارسی: ساخت محیط مجازی ناموفق بود.
    goto :end
)
echo Installing aiohttp...
"%VENV%\Scripts\python.exe" -m pip install aiohttp
if errorlevel 1 (
    echo [FAIL] Installing aiohttp did not succeed - check your internet connection.
    echo   فارسی: نصب aiohttp ناموفق بود — اتصال اینترنت را بررسی کنید.
    goto :end
)
"%VENV%\Scripts\python.exe" preflight.py --root "%cd%"
if errorlevel 1 goto :end
set "PY=%VENV%\Scripts\python.exe"
goto :run

:abort
echo.
echo [ABORTED] Fix the problem(s) listed above, then run this file again.
echo   فارسی: مشکل‌های بالا را رفع کنید و دوباره اجرا کنید.
goto :end

:run
echo.
echo Starting Inksync server on http://localhost:8765/   (Ctrl-C to stop)
echo برای توقف سرور Ctrl-C بزنید
"%PY%" server.py
set "RC=%errorlevel%"
echo.
if "%RC%"=="0" (
    echo Server stopped.        سرور متوقف شد.
) else (
    echo [FAIL] Inksync exited unexpectedly ^(exit code %RC%^).
    echo        The actual error is printed above - scroll up.
    echo   فارسی: سرور با خطا متوقف شد — متن خطا بالای همین پیام‌ها است.
)

:end
echo.
pause
