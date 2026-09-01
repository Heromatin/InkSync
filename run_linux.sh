#!/bin/bash
# Inksync launcher (Linux) — checks requirements, then starts the server.
#
# این فایل را کنار server.py نگه دارید
# برای دابل‌کلیک شدن باید executable باشد:
#   chmod +x run_linux.sh
# بعضی فایل‌منیجرها هم باید تنظیم شوند که .sh را «اجرا» کنند نه اینکه در ادیتور باز کنند
# (معمولاً در Settings فایل‌منیجر گزینه‌ای هست: "Run executable text files when opened")

cd "$(dirname "$0")" || exit 1

APP="Inksync"
VENV_DIR=".venv"

finish() {
    echo ""
    read -r -p "Press Enter to close…    برای بستن Enter بزنید… "
    exit "${1:-0}"
}

# ------------------------------------------------ pick a Python interpreter
if [ -x "$VENV_DIR/bin/python" ]; then
    PY="$VENV_DIR/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    PY="python3"
elif command -v python >/dev/null 2>&1; then
    PY="python"
else
    echo "[FAIL] Python 3 was not found on this system."
    echo "       Install it first, for example:  sudo apt install python3"
    echo "  فارسی: پایتون ۳ نصب نیست — اول آن را نصب کنید."
    finish 1
fi

# ------------------------------------------------ pre-flight checks
echo "Checking requirements for $APP…      بررسی پیش‌نیازها…"
"$PY" preflight.py --root "$PWD"
RC=$?

if [ "$RC" -eq 0 ]; then
    :
elif [ "$RC" -eq 2 ]; then
    # everything is fine except the missing aiohttp package
    echo ""
    read -r -p "Install the missing package now? (creates a private .venv — needs internet) [y/N] "
    # نصب کنم؟ y/n
    case "$REPLY" in
        y|Y|yes|Yes|YES)
            echo ""
            echo "Creating virtual environment (.venv)…"
            if ! "$PY" -m venv "$VENV_DIR"; then
                echo "[FAIL] Could not create the virtual environment."
                echo "       On Debian/Ubuntu:  sudo apt install python3-venv"
                echo "       Or install manually:  $PY -m pip install --user aiohttp"
                echo "  فارسی: ساخت محیط مجازی ناموفق بود."
                finish 1
            fi
            echo "Installing aiohttp…"
            if ! "$VENV_DIR/bin/python" -m pip install aiohttp; then
                echo "[FAIL] Installing aiohttp did not succeed — check your internet connection."
                echo "  فارسی: نصب aiohttp ناموفق بود — اتصال اینترنت را بررسی کنید."
                finish 1
            fi
            "$VENV_DIR/bin/python" preflight.py --root "$PWD"
            if [ $? -ne 0 ]; then
                finish 1
            fi
            PY="$VENV_DIR/bin/python"
            ;;
        *)
            echo "Install it manually, then run this file again:"
            echo "    $PY -m pip install aiohttp"
            echo "  فارسی: دستی نصب کنید و دوباره اجرا کنید."
            finish 1
            ;;
    esac
else
    echo ""
    echo "[ABORTED] Fix the problem(s) listed above, then run this file again."
    echo "  فارسی: مشکل‌های بالا را رفع کنید و دوباره اجرا کنید."
    finish 1
fi

# ------------------------------------------------ start the server
echo ""
echo "Starting $APP server on http://localhost:8765/   (Ctrl-C to stop)"
echo "برای توقف سرور Ctrl-C بزنید"
"$PY" server.py
RC=$?

echo ""
if [ "$RC" -eq 0 ]; then
    echo "Server stopped.        سرور متوقف شد."
else
    echo "[FAIL] $APP exited unexpectedly (exit code $RC)."
    echo "       The actual error is printed above — scroll up."
    echo "  فارسی: سرور با خطا متوقف شد — متن خطا بالای همین پیام‌ها است."
fi
finish "$RC"
