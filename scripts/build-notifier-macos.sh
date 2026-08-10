#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="$ROOT/scripts/notifier/OpencodexNotifier"
APP_DIR="$ROOT/native/OpencodexNotifier.app"
CONTENTS="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES_DIR="$CONTENTS/Resources"
ICON_SOURCE="$ROOT/media/opencodex-notification.png"
TARGET="$(uname -m)"
MIN_MACOS="10.14"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "error: swiftc not found. Install Xcode Command Line Tools." >&2
  exit 1
fi

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

echo "Compiling OpencodexNotifier (arm64)..."
swiftc -O -target "arm64-apple-macosx$MIN_MACOS" \
  "$SOURCE_DIR/main.swift" \
  -o "$MACOS_DIR/OpencodexNotifier-arm64"

echo "Compiling OpencodexNotifier (x86_64)..."
swiftc -O -target "x86_64-apple-macosx$MIN_MACOS" \
  "$SOURCE_DIR/main.swift" \
  -o "$MACOS_DIR/OpencodexNotifier-x86_64"

echo "Merging universal binary..."
lipo -create \
  "$MACOS_DIR/OpencodexNotifier-arm64" \
  "$MACOS_DIR/OpencodexNotifier-x86_64" \
  -output "$MACOS_DIR/OpencodexNotifier"
rm -f "$MACOS_DIR/OpencodexNotifier-arm64" "$MACOS_DIR/OpencodexNotifier-x86_64"
chmod +x "$MACOS_DIR/OpencodexNotifier"

echo "Generating AppIcon.icns from $ICON_SOURCE..."
ICONSET="$(mktemp -d)/Opencodex.iconset"
mkdir -p "$ICONSET"
for spec in "16:icon_16x16" "32:icon_16x16@2x" "32:icon_32x32" "64:icon_32x32@2x" "128:icon_128x128" "256:icon_128x128@2x" "256:icon_256x256" "512:icon_256x256@2x" "512:icon_512x512" "1024:icon_512x512@2x"; do
  size="${spec%%:*}"
  name="${spec##*:}"
  sips -z "$size" "$size" "$ICON_SOURCE" --out "$ICONSET/$name.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RESOURCES_DIR/AppIcon.icns"
rm -rf "$(dirname "$ICONSET")"

cp "$SOURCE_DIR/Info.plist" "$CONTENTS/Info.plist"
plutil -lint "$CONTENTS/Info.plist" >/dev/null

if command -v xattr >/dev/null 2>&1; then
  xattr -cr "$APP_DIR" 2>/dev/null || true
fi

if command -v codesign >/dev/null 2>&1; then
  echo "Ad-hoc codesigning..."
  codesign --force --sign - "$APP_DIR"
fi

echo "Built $APP_DIR"
lipo -archs "$MACOS_DIR/OpencodexNotifier"
echo "Universal binary: $MACOS_DIR/OpencodexNotifier ($TARGET host)"
