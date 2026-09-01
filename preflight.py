#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pre-flight checks for the Inksync server launchers (run_*.sh/.bat).

Verifies everything the app needs BEFORE server.py is started:
  - Python version
  - the aiohttp package
  - required app files/folders
  - a writable docs/ folder (annotations & PDFs are saved there)
  - that the server port is free

It prints a clear report of what was checked, what is missing and how to
fix it, then sets the process exit code:

    0   all checks passed
    1   blocking problem(s) found           -> launcher stops
    2   the ONLY problem is that the 'aiohttp' package is missing
        -> launcher offers to install it into a private .venv

Deliberately written in "old Python" style (no f-strings, no pathlib) so
that even a very old interpreter can still run it far enough to report
"It is too old" instead of dying with a SyntaxError.
"""

import argparse
import os
import socket
import sys

APP_NAME = "Inksync"
PORT = 8765  # keep in sync with PORT in server.py
MIN_PYTHON = (3, 10)

REQUIRED_FILES = (
    "server.py",
    "web/index.html",
    "web/reader.html",
    "web/writer.html",
    "web/sw.js",
    "web/manifest.json",
)
REQUIRED_DIRS = (
    "web/css",
    "web/js",
    "web/vendor",
    "web/img",
)

# every check returns: (level, label, detail, fix, fix_fa)
#   level: "ok" | "warn" | "fail"       fix/fix_fa: None when all is fine
TAGS = {"ok": "[ OK ]", "warn": "[WARN]", "fail": "[FAIL]"}


def _which(cmd):
    """shutil.which() equivalent that also works on ancient Pythons."""
    extensions = [""] if os.name != "nt" else ["", ".exe", ".bat", ".cmd"]
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        if not directory:
            continue
        base = os.path.join(directory, cmd)
        for ext in extensions:
            candidate = base + ext
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
    return None


# ----------------------------------------------------------------- checks

def check_python():
    v = sys.version_info
    found = ".".join(str(n) for n in v[:3])
    need = ".".join(str(n) for n in MIN_PYTHON)
    if v >= MIN_PYTHON:
        return ("ok", "Python", found, None, None)
    return (
        "fail",
        "Python",
        "found %s, need %s or newer" % (found, need),
        "Install Python %s+ from https://www.python.org/downloads/" % need,
        "پایتون قدیمی است — نسخهٔ %s یا جدیدتر لازم است" % need,
    )


def check_aiohttp():
    try:
        import aiohttp
    except Exception as exc:
        return (
            "fail",
            "aiohttp",
            "not available (%s)" % exc,
            "python -m pip install aiohttp",
            "کتابخانهٔ aiohttp نصب نیست",
        )
    return ("ok", "aiohttp", getattr(aiohttp, "__version__", "installed"), None, None)


def check_app_files(root):
    missing = [rel for rel in REQUIRED_FILES if not os.path.isfile(os.path.join(root, rel))]
    missing += [rel for rel in REQUIRED_DIRS if not os.path.isdir(os.path.join(root, rel))]
    if missing:
        return (
            "fail",
            "App files",
            "missing: %s" % ", ".join(missing),
            "Re-copy the complete app folder — these files ship with it",
            "فایل‌های برنامه ناقص است — پوشهٔ کامل برنامه را دوباره کپی کنید",
        )
    return (
        "ok",
        "App files",
        "%d files/folders verified" % (len(REQUIRED_FILES) + len(REQUIRED_DIRS)),
        None,
        None,
    )


def check_docs_dir(root):
    docs = os.path.join(root, "docs")
    try:
        if not os.path.isdir(docs):
            os.makedirs(docs)
        probe = os.path.join(docs, ".preflight-write-test")
        with open(probe, "w") as fh:
            fh.write("ok")
        os.remove(probe)
    except EnvironmentError as exc:
        return (
            "fail",
            "docs/ folder",
            "not writable (%s)" % exc,
            "Fix the folder permissions so this user can write to it",
            "پوشهٔ docs قابل نوشتن نیست — دسترسی پوشه را بررسی کنید",
        )
    return ("ok", "docs/ folder", "writable", None, None)


def check_port():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.5)
    try:
        sock.connect(("127.0.0.1", PORT))
        in_use = True
    except EnvironmentError:
        in_use = False
    finally:
        sock.close()
    if in_use:
        return (
            "fail",
            "Port %d" % PORT,
            "already in use — another %s instance is probably still running" % APP_NAME,
            "Stop the running instance first (or restart the PC), then try again",
            "پورت %d اشغال است — احتمالاً یک نسخهٔ دیگر از سرور هنوز در حال اجراست" % PORT,
        )
    return ("ok", "Port %d" % PORT, "free", None, None)


def check_ip_cmd():
    # Only Linux: server.py shells out to `ip` and silently falls back to a
    # less accurate method when it is missing — surface that as a warning.
    if sys.platform != "linux":
        return None
    if _which("ip") is None:
        return (
            "warn",
            "'ip' command",
            "not found — LAN IP detection will fall back to a less accurate method",
            "Optional: install it with  sudo apt install iproute2",
            "دستور ip پیدا نشد — تشخیص IP شبکه ممکن است دقیق نباشد (اختیاری)",
        )
    return ("ok", "'ip' command", "found", None, None)


# ---------------------------------------------------------------- reporting

def run_checks(root):
    checks = (
        check_python,
        check_aiohttp,
        lambda: check_app_files(root),
        lambda: check_docs_dir(root),
        check_port,
        check_ip_cmd,
    )
    results = []
    for check in checks:
        result = check()
        if result is not None:
            results.append(result)
    return results


def print_report(results):
    for level, label, detail, _fix, _fix_fa in results:
        print("%s %-14s %s" % (TAGS[level], label, detail))
    print()

    failures = [r for r in results if r[0] == "fail"]
    if not failures:
        print("All checks passed — starting server…")
        print("همهٔ پیش‌نیازها آماده است.")
        return

    print("%d problem(s) found — how to fix:" % len(failures))
    for i, (_level, label, detail, fix, fix_fa) in enumerate(failures, 1):
        print(" %d. %s — %s" % (i, label, detail))
        if fix:
            print("    fix:    %s" % fix)
        if fix_fa:
            print("    فارسی:  %s" % fix_fa)
    print()
    print("Fix the problem(s) above, then start again.")
    print("مشکل‌های بالا را رفع کنید و دوباره اجرا کنید.")


def main():
    parser = argparse.ArgumentParser(description="%s pre-flight checks" % APP_NAME)
    parser.add_argument(
        "--root",
        default=os.path.dirname(os.path.abspath(__file__)),
        help="app folder to check (default: folder containing this script)",
    )
    args = parser.parse_args()
    root = os.path.abspath(args.root)

    print("%s pre-flight check — %s" % (APP_NAME, root))
    print("بررسی پیش‌نیازها…")
    print()

    results = run_checks(root)
    print_report(results)

    failures = [r for r in results if r[0] == "fail"]
    if not failures:
        return 0
    if len(failures) == 1 and failures[0][1] == "aiohttp":
        return 2
    return 1


if __name__ == "__main__":
    sys.exit(main())
