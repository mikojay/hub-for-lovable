#!/bin/bash
# Builds "dist/Hub for Lovable.app" from the Electron copy in node_modules (no extra tools needed).
# Usage: npm run package    then drag dist/Hub for Lovable.app into /Applications.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="Hub for Lovable"
APP="dist/$NAME.app"
RES="$APP/Contents/Resources"
PLIST="$APP/Contents/Info.plist"
VERSION=$(node -p 'require("./package.json").version')

rm -rf dist && mkdir -p dist
ditto node_modules/electron/dist/Electron.app "$APP"

# the app's own files (no runtime dependencies, so no node_modules)
rm -f "$RES/default_app.asar"
mkdir -p "$RES/app"
cp main.js preload.js lovable-dom.js modwatch.js no-passkeys.js package.json "$RES/app/"
ditto ui "$RES/app/ui"

# name, id, version, icon
cp build/icon.icns "$RES/electron.icns"
pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST"; }
pb "Set :CFBundleName $NAME"
pb "Set :CFBundleDisplayName $NAME" 2>/dev/null || pb "Add :CFBundleDisplayName string $NAME"
pb "Set :CFBundleIdentifier dev.hubforlovable.app"
pb "Set :CFBundleShortVersionString $VERSION"
pb "Set :CFBundleVersion $VERSION"

# changing the bundle breaks Electron's signature; re-sign locally (ad-hoc) so macOS runs it
codesign --force --deep --sign - "$APP" 2>&1 | grep -v "replacing existing signature" || true
echo "Built $APP"
