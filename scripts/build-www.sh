#!/usr/bin/env bash
# Copies frontend-only files into www/ for Capacitor bundling.
# Run: npm run build

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WWW="$ROOT/www"

rm -rf "$WWW"
mkdir -p "$WWW"

# HTML pages
cp "$ROOT"/*.html "$WWW"/

# Client-side JS (not the api/ server routes)
cp "$ROOT/shared.css"     "$WWW/"
cp "$ROOT/api-base.js"    "$WWW/"
cp "$ROOT/offline.js"     "$WWW/"
cp "$ROOT/onboarding.js"  "$WWW/"
cp "$ROOT/chat-widget.js"      "$WWW/"
cp "$ROOT/sentiment-widget.js" "$WWW/"
cp "$ROOT/auth.js"        "$WWW/"

# Static data assets
if [ -d "$ROOT/data" ]; then
  cp -r "$ROOT/data" "$WWW/data"
fi

echo "✓ www/ built ($(find "$WWW" -type f | wc -l | tr -d ' ') files)"
