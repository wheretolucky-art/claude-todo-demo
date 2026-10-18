#!/usr/bin/env bash
# Installs the test APK on the emulator, opens it, and takes screenshots of a few screens:
# start, the + menu, back button, Settings, and the share sheet from "Back up now".
set -uo pipefail
OUT="$(cd "$(dirname "$0")/.." && pwd)/out"
PKG=com.debugnetworks.office
LOG="$OUT/smoke.log"
shot() { adb exec-out screencap -p > "$OUT/$1.png"; echo "screenshot $1" >> "$LOG"; }
find_node() {
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1
  adb pull /sdcard/ui.xml "$OUT/ui-$2.xml" > /dev/null 2>&1
  python3 - "$1" "$OUT/ui-$2.xml" <<'PY'
import re, sys
want, path = sys.argv[1], sys.argv[2]
try:
    xml = open(path, encoding='utf-8', errors='ignore').read()
except OSError:
    sys.exit(0)
for m in re.finditer(r'<node [^>]*>', xml):
    node = m.group(0)
    text = re.search(r' text="([^"]*)"', node)
    desc = re.search(r' content-desc="([^"]*)"', node)
    box = re.search(r' bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
    label = (text.group(1) if text else '') + '|' + (desc.group(1) if desc else '')
    if want in label and box:
        x1, y1, x2, y2 = map(int, box.groups())
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
PY
}
tap() { local xy; xy="$(find_node "$1" "$2")"; echo "tap '$1' at: ${xy:-not found}" >> "$LOG"; [ -n "$xy" ] && adb shell input tap $xy; }

adb wait-for-device
echo "== install" > "$LOG"
adb install -r "$OUT/dn-office-test.apk" >> "$LOG" 2>&1
adb shell am start -W -n "$PKG/.MainActivity" >> "$LOG" 2>&1
sleep 25
shot screen-1-start
tap "New quote, job or client" fab && sleep 4 && shot screen-2-new-menu
adb shell input keyevent KEYCODE_BACK; sleep 3; shot screen-3-after-back
tap "Settings" nav && sleep 4 && shot screen-4-settings
tap "Back up now" backup && sleep 6 && shot screen-5-share-sheet
adb shell input keyevent KEYCODE_BACK; sleep 2
adb shell pidof "$PKG" >> "$LOG" 2>&1 && echo "app still running" >> "$LOG"
adb logcat -d -s chromium:V AndroidRuntime:E ActivityManager:W > "$OUT/logcat.txt" 2>&1 || true
exit 0
