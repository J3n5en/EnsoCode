#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
IOS_DIR="$ROOT/packages/ios-app"

echo "[ios-app] building @enso/phone web bundle..."
(cd "$ROOT" && pnpm --filter @enso/phone build)

echo "[ios-app] syncing packages/phone/dist -> packages/ios-app/WebApp"
rm -rf "$IOS_DIR/WebApp"
mkdir -p "$IOS_DIR/WebApp"
cp -R "$ROOT/packages/phone/dist/." "$IOS_DIR/WebApp/"

if command -v xcodegen >/dev/null 2>&1; then
  echo "[ios-app] generating EnsoCode.xcodeproj via xcodegen..."
  (cd "$IOS_DIR" && xcodegen generate)
else
  echo "[ios-app] xcodegen not installed; run 'brew install xcodegen && xcodegen generate' in packages/ios-app"
fi
