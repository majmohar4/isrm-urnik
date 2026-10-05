#!/usr/bin/env bash
# One-step release of the website, PWA and Android app under ONE version (src/version.js), then deploy and verify.
#
#   ./tool/release.sh "Note one|Note two"              # next version (x.y -> x.(y+1), x.9 -> (x+1).0)
#   VERSION=3.0 ./tool/release.sh "Note one|Note two"  # a chosen version
#   ./tool/release.sh deploy                           # deploy current code only, no new version
#
# The Android versionCode is derived from the version by Gradle (3.0 -> 30000). Release notes appear in the in-app
# update sheet; separate items with "|". Optional.
#
# Needs: ssh access to the server, JDK 17, and the signing key in $ISRM_SIGNING_DIR (default ~/.isrm-signing,
# containing isrm-release.jks and credentials.txt with ALIAS= and PASSWORD=). Nothing secret lives in this repo.
set -euo pipefail

if [ "${1:-}" = deploy ]; then MODE=deploy; NOTES=""; else MODE=release; NOTES="${1:-}"; fi
SERVER="${ISRM_SERVER:-home@192.168.50.26}"
REMOTE_DIR="${ISRM_REMOTE_DIR:-Documents/stacks/isrm-urnik}"
PUBLIC_URL="${ISRM_PUBLIC_URL:-https://isrm.majmohar.eu}"
SIGNING_DIR="${ISRM_SIGNING_DIR:-$HOME/.isrm-signing}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"


bump() { # 2.4 -> 2.5, 2.9 -> 3.0
  local major="${1%%.*}" minor="${1#*.}"
  minor=$((10#${minor%%.*} + 1))
  if [ "$minor" -ge 10 ]; then echo "$((major + 1)).0"; else echo "$major.$minor"; fi
}

say() { printf '\n==> %s\n' "$*"; }

if [ "$MODE" = release ]; then
  OLD_WEB=$(sed -n "s/.*APP_VERSION = '\(.*\)'.*/\1/p" src/version.js)
  NEW_WEB="${VERSION:-$(bump "$OLD_WEB")}"
  [[ "$NEW_WEB" =~ ^[0-9]+\.[0-9]+$ ]] || { echo "Version must look like 3.0, got $NEW_WEB"; exit 1; }
  OLD_CACHE=$(sed -n "s/.*isrm-urnik-v\([0-9]*\).*/\1/p" public/sw.js)
  NEW_CACHE=$((OLD_CACHE + 1))
  sed -i.bak "s/APP_VERSION = '$OLD_WEB'/APP_VERSION = '$NEW_WEB'/" src/version.js && rm src/version.js.bak
  sed -i.bak "s/isrm-urnik-v$OLD_CACHE/isrm-urnik-v$NEW_CACHE/" public/sw.js && rm public/sw.js.bak
  say "Version $OLD_WEB -> $NEW_WEB for website, PWA and app (service-worker cache v$NEW_CACHE)"
fi

say "Building the website"
npm run build --silent >/dev/null

if [ "$MODE" = release ]; then
  NEW_APP="$NEW_WEB"
  say "Building the signed Android APK $NEW_APP"
  # Read field by field: macOS ships bash 3.2, where `source <(...)` silently defines nothing.
  ALIAS=$(sed -n 's/^ALIAS=//p' "$SIGNING_DIR/credentials.txt")
  PASSWORD=$(sed -n 's/^PASSWORD=//p' "$SIGNING_DIR/credentials.txt")
  [ -n "$ALIAS" ] && [ -n "$PASSWORD" ] || { echo "Signing details missing in $SIGNING_DIR/credentials.txt"; exit 1; }
  APK="android/app/build/outputs/distribution/IŠRM-$NEW_APP.apk"
  rm -f "$APK"
  (cd android && JAVA_HOME="$(/usr/libexec/java_home -v 17)" ./gradlew -q :app:packageReleaseApk \
    -PVERSION_NAME="$NEW_APP" -PRELEASE_STORE_FILE="$SIGNING_DIR/isrm-release.jks" \
    -PRELEASE_STORE_PASSWORD="$PASSWORD" -PRELEASE_KEY_ALIAS="$ALIAS" -PRELEASE_KEY_PASSWORD="$PASSWORD")
  test -f "$APK" || { echo "Build failed: $APK missing"; exit 1; }
  # The tag only changes the URL, so a cached copy of an older file with the same name is never served.
  TAG="$(date +%Y%m%d%H%M)"
  APK_URL="$PUBLIC_URL/downloads/ISRM-$NEW_APP.apk?build=$TAG"
  say "Uploading ISRM-$NEW_APP.apk"
  rsync -a "$APK" "$SERVER:$REMOTE_DIR/releases/ISRM-$NEW_APP.apk"
  NOTES_SED=$(printf '%s' "$NOTES" | sed 's/[#&\\]/\\&/g')
  ssh -o BatchMode=yes "$SERVER" "cd $REMOTE_DIR && sed -i 's#^ANDROID_APP_VERSION=.*#ANDROID_APP_VERSION=$NEW_APP#; s#^ANDROID_APK_URL=.*#ANDROID_APK_URL=$APK_URL#' .env && \
    if grep -q '^ANDROID_RELEASE_NOTES=' .env; then sed -i 's#^ANDROID_RELEASE_NOTES=.*#ANDROID_RELEASE_NOTES=$NOTES_SED#' .env; else echo 'ANDROID_RELEASE_NOTES=$NOTES_SED' >> .env; fi"
fi

say "Deploying to $SERVER"
rsync -a server.mjs compose.yaml Dockerfile .dockerignore package.json package-lock.json programme-sources.json index.html vite.config.js "$SERVER:$REMOTE_DIR/"
rsync -a src/ "$SERVER:$REMOTE_DIR/src/"
rsync -a public/ "$SERVER:$REMOTE_DIR/public/"
# --force-recreate: a plain `up -d --build` on this Docker setup builds the image but keeps the old container running.
ssh -o BatchMode=yes "$SERVER" "cd $REMOTE_DIR && docker compose up -d --build --force-recreate >/dev/null 2>&1 && \
  for i in \$(seq 1 40); do docker compose ps --format '{{.Status}}' | grep -q '(healthy)' && exit 0; sleep 3; done; echo 'Container did not become healthy'; exit 1"

say "Verifying"
LIVE_JS=$(curl -fsS "$PUBLIC_URL/" | grep -o 'assets/index-[^"]*\.js' | head -1)
LOCAL_JS="assets/$(ls dist/assets | grep '\.js$' | head -1)"
[ "$LIVE_JS" = "$LOCAL_JS" ] && echo "website: live bundle matches ($LIVE_JS)" || { echo "website: live $LIVE_JS != local $LOCAL_JS"; exit 1; }
echo "service worker: $(curl -fsS "$PUBLIC_URL/sw.js" | head -1)"
if [ -n "${NEW_APP:-}" ]; then
  echo "release: $(curl -fsS "$PUBLIC_URL/api/release")"
  LIVE_SIZE=$(curl -fsSL -o /dev/null -w '%{size_download}' "$PUBLIC_URL/download")
  LOCAL_SIZE=$(wc -c < "$APK" | tr -d ' ')
  [ "$LIVE_SIZE" = "$LOCAL_SIZE" ] && echo "APK: /download serves the new build ($LIVE_SIZE bytes)" || { echo "APK: live $LIVE_SIZE != local $LOCAL_SIZE bytes"; exit 1; }
fi
say "Done${NEW_WEB:+ — version $NEW_WEB is live for the website, PWA and app}. Not committed: commit and push when ready."
