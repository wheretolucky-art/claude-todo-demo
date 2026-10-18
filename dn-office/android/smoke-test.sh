#!/usr/bin/env bash
# Installs the debuggable test APK on the emulator, opens it, and lets cdp-test.mjs drive the page
# (made-up sample records only) while it takes screenshots and records what happened.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/.." && pwd)/out"
PKG=com.debugnetworks.office
LOG="$OUT/smoke.log"
adb wait-for-device
echo "== install" > "$LOG"
adb install -r "$OUT/dn-office-test.apk" >> "$LOG" 2>&1
adb shell am start -W -n "$PKG/.MainActivity" >> "$LOG" 2>&1
sleep 15
adb exec-out screencap -p > "$OUT/screen-0-start.png"
timeout 240 node "$HERE/cdp-test.mjs" "$OUT" >> "$LOG" 2>&1 || echo "cdp-test exited with $?" >> "$LOG"
adb shell pidof "$PKG" >> "$LOG" 2>&1 && echo "app still running" >> "$LOG"
adb logcat -d -s chromium:V AndroidRuntime:E ActivityManager:W > "$OUT/logcat.txt" 2>&1 || true
exit 0
