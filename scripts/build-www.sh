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
cp "$ROOT/theme.js"       "$WWW/"
cp "$ROOT/api-base.js"    "$WWW/"
cp "$ROOT/offline.js"     "$WWW/"
cp "$ROOT/onboarding.js"  "$WWW/"
cp "$ROOT/chat-widget.js"      "$WWW/"
cp "$ROOT/sentiment-widget.js" "$WWW/"
cp "$ROOT/auth.js"        "$WWW/"
cp "$ROOT/track-record.js" "$WWW/"
cp "$ROOT/tab-shell.js"   "$WWW/"

# Brand assets (logo, favicons)
if [ -d "$ROOT/images" ]; then
  cp -r "$ROOT/images" "$WWW/images"
fi
cp "$ROOT/favicon.ico"        "$WWW/"
cp "$ROOT/site.webmanifest"   "$WWW/"

echo "✓ www/ built ($(find "$WWW" -type f | wc -l | tr -d ' ') files)"
