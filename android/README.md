# IŠRM Android

This is a fully native Android timetable. It stores timetable weeks locally, renders the schedule with Android views, refreshes in the background, and publishes a real Android home-screen widget. A PWA cannot provide an Android home-screen widget; this project uses `AppWidgetProvider` and WorkManager instead.

## Build

1. Open the `android` folder in Android Studio (JDK 17 and Android SDK 35), or run `./gradlew :app:assembleDebug`.
2. In `gradle.properties`, set `WEB_APP_URL` to the HTTPS address of the deployed app.
3. Use **Build > Generate Signed Bundle / APK** to produce a signed release. Supply `VERSION_NAME` and an ever-increasing `VERSION_CODE`, then run `./gradlew :app:packageReleaseApk :app:exportPlayBundle`. Its distribution outputs are `IŠRM-<VERSION_NAME>.apk` (direct download) and `IŠRM-<VERSION_NAME>.aab` (Google Play upload).

The widget configuration screen supports a next-lesson card and a whole-day layout. It reads the same local cache as the app when offline. Only while at least one widget exists, it uses a network-constrained WorkManager refresh every six hours; the app itself does not run a repeating background task. Android may delay background work under battery-saving rules, and tapping the widget refresh control triggers an immediate refresh. The merged AndroidX worker manifest adds standard network and background-scheduling permissions; the app requests no location, contacts, camera, files, or notification access.

## In-app updates

On launch the app reads `/api/release`; when a newer version is offered it shows an update sheet with the release notes (`ANDROID_RELEASE_NOTES` in the server `.env`, items separated by `|`). "Posodobi zdaj" downloads the APK into the app's private cache with a progress bar and hands it to Android's `PackageInstaller`. The first time, Android asks to allow "install unknown apps" for IŠRM; after that there is one confirmation tap, and on Android 12+ later updates can go through without it once IŠRM itself installed the current version. Android 10+ does not let an app reopen itself in the background, so the user reopens it after the update. Settings has "Preveri posodobitve" for a manual check. For manual updates, `/download` always redirects to the newest APK (linked in the update sheet, in settings and on `/android`; long-press the link in the app to copy it).

## Failsafe when the server is down

If the IŠRM server cannot be reached (or answers with a server error and no data), the app reads the week straight from the FRI and FMF pages and parses them with the same rules as `server.mjs` (`DirectSource.kt` mirrors `parseFri` / `parseFmf` — change both together). The source links come from `/api/sources` and are remembered on the phone, so the failsafe follows semester changes; built-in defaults cover a fresh install. Admin-added events live only on the server, so the last known ones are kept. A notice tells the user the timetable was loaded directly, and the next open asks the server again first.

## Public release

The repository includes `.github/workflows/android-release.yml`. Create a signing keystore outside the repository and add these GitHub Actions secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Creating a tag such as `v1.1` builds a signed release asset named `IŠRM-1.1.apk` and attaches it to that GitHub Release (GitHub stores it as `ISRM-1.1.apk`, without the Š).

After GitHub publishes the asset, set these values in the server `.env`, then run `docker compose up -d --build`:

```env
ANDROID_APP_VERSION=1.1
ANDROID_APK_URL=https://github.com/majmohar4/isrm-urnik/releases/download/v1.1/ISRM-1.1.apk
ANDROID_RELEASE_URL=https://isrm.majmohar.eu/android
```

### Self-hosted APK

The server can also serve the APK itself, without a GitHub Release. Build it signed with the same keystore as the GitHub workflow (otherwise it cannot install over existing copies):

```sh
./gradlew :app:packageReleaseApk -PVERSION_NAME=1.6 \
  -PRELEASE_STORE_FILE=… -PRELEASE_STORE_PASSWORD=… -PRELEASE_KEY_ALIAS=… -PRELEASE_KEY_PASSWORD=…
```

Copy `app/build/outputs/distribution/IŠRM-1.6.apk` to the server as `releases/ISRM-1.6.apk` (ASCII name; the folder is mounted read-only into the container by `compose.yaml` and is ignored by git and Docker). It is then served at `/downloads/ISRM-1.6.apk`. Point `.env` at it and recreate the container (`docker compose up -d --build --force-recreate`):

```env
ANDROID_APP_VERSION=2.3
ANDROID_APK_URL=https://isrm.majmohar.eu/downloads/ISRM-2.3.apk?build=20300-20261005
```

The `?build=` tag is ignored by the server but changes the URL, so a rebuilt APK under the same file name never reaches users from a stale Cloudflare copy. Change it whenever the file is replaced.

`VERSION_CODE` is derived from the version (1.7 → 10700) by both Gradle and the workflow, so it always increases.

Android visitors to the website are offered the native APK instead of the PWA. The app checks `/api/release` on launch; if its installed version is older, it opens `/android?installed=<version>`. That stable update page compares versions and offers the current signed APK. Android requires a user confirmation before installing an APK, so neither the website nor the app silently installs it.

## Play Store and security

The direct GitHub APK is signed, but Android can still show an installation warning for every app installed from a browser. That warning identifies a **sideloaded source**; it cannot be removed by code in the app. Do not promise users otherwise.

For the normal, store-verified experience, upload the signed `IŠRM-<VERSION_NAME>.aab` to Google Play Console and use [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756). The GitHub workflow now creates that AAB as a private workflow artifact for each tag. Keep the package id (`eu.majmohar.isrm`), upload key, and signing lineage stable; a lost signing key prevents updates to existing direct installs.

Before submitting a Play release:

1. Upload the AAB to internal testing first and resolve every Play pre-launch report issue.
2. Complete the Data safety declaration from the behavior of the submitted build, and link the public policy at `https://isrm.majmohar.eu/privacy`.
3. Publish a truthful store listing, developer contact email, screenshots, and a release note. Do not claim automatic or silent APK installation.
4. Keep Android, Gradle dependencies, and the signing key current. Review the release APK with `apkanalyzer` or Android Studio before publishing.

The app deliberately has a small permission surface: it declares `INTERNET` and `REQUEST_INSTALL_PACKAGES` (in-app updates of the self-hosted APK — Android asks the user once, and only APKs signed with the IŠRM key can replace the app; drop it from the manifest for a Play Store build, where Play handles updates); backups are disabled; clear-text HTTP is forbidden by both the manifest and network-security configuration; and release builds are R8-minified and resource-shrunk. Its fixed production endpoint must therefore be HTTPS. These controls reduce risk but do not override Google Play's independent review or Play Protect decisions.
