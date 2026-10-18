#!/usr/bin/env bash
# Builds DN Office for Android with the SDK's own tools (aapt2, javac, d8, zipalign).
# Output in dn-office/out: an unsigned, aligned APK for release signing, a test-signed APK for
# the emulator check, the apksigner tool, and the build log.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
OUT="$ROOT/out"
B="$ROOT/.build"
rm -rf "$OUT" "$B"
mkdir -p "$OUT" "$B/res" "$B/gen" "$B/classes" "$B/dex" "$B/assets/www"
exec > >(tee "$OUT/build.log") 2>&1

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
BT="$(ls -d "$SDK"/build-tools/*/ | sort -V | tail -1)"; BT="${BT%/}"
PLATFORM="$(ls -d "$SDK"/platforms/android-*/ | sort -V | tail -1)"; PLATFORM="${PLATFORM%/}"
JAR="$PLATFORM/android.jar"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-1.0.$VERSION_CODE}"
echo "build-tools: $BT"
echo "platform:    $PLATFORM"
echo "version:     $VERSION_NAME ($VERSION_CODE)"
java -version

echo "== 1. Web app into assets"
cp "$ROOT/web/index.html" "$ROOT/web/manifest.webmanifest" "$ROOT/web/icon-192.png" "$ROOT/web/icon-512.png" "$B/assets/www/"
curl -fsSL --retry 3 https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js -o "$B/assets/www/jspdf.umd.min.js"
sed -i 's#https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js#jspdf.umd.min.js#' "$B/assets/www/index.html"
grep -q 'src="jspdf.umd.min.js"' "$B/assets/www/index.html"
ls -la "$B/assets/www"

echo "== 2. Resources and manifest"
"$BT/aapt2" compile --dir res -o "$B/res/compiled.zip"
"$BT/aapt2" link -o "$B/base.apk" -I "$JAR" --manifest AndroidManifest.xml -A "$B/assets" \
  --java "$B/gen" --min-sdk-version 23 --target-sdk-version 34 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" "$B/res/compiled.zip"

echo "== 3. Code"
javac -source 8 -target 8 -bootclasspath "$JAR" -classpath "$JAR" -encoding UTF-8 -Xlint:-options \
  -d "$B/classes" $(find src "$B/gen" -name '*.java')
"$BT/d8" --release --min-api 23 --lib "$JAR" --output "$B/dex" $(find "$B/classes" -name '*.class')

echo "== 4. Package and align"
cp "$B/base.apk" "$B/unaligned.apk"
(cd "$B/dex" && zip -q -X "$B/unaligned.apk" classes.dex)
"$BT/zipalign" -f -p 4 "$B/unaligned.apk" "$OUT/dn-office-unsigned.apk"

echo "== 5. Test-signed copy for the emulator, and the signing tool"
keytool -genkeypair -keystore "$B/test.jks" -storetype PKCS12 -storepass testpass -keypass testpass -alias test \
  -keyalg RSA -keysize 2048 -validity 365 -dname "CN=DN Office test" -noprompt
"$BT/apksigner" sign --ks "$B/test.jks" --ks-pass pass:testpass --key-pass pass:testpass \
  --out "$OUT/dn-office-test.apk" "$OUT/dn-office-unsigned.apk"
"$BT/apksigner" verify --verbose "$OUT/dn-office-test.apk"
cp "$BT/lib/apksigner.jar" "$OUT/apksigner.jar"
"$BT/aapt2" dump badging "$OUT/dn-office-test.apk" | head -n 25
ls -la "$OUT"
echo "BUILD OK"
