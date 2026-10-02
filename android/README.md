# IŠRM Android

This is a fully native Android timetable. It stores timetable weeks locally, renders the schedule with Android views, refreshes in the background, and publishes a real Android home-screen widget. A PWA cannot provide an Android home-screen widget; this project uses `AppWidgetProvider` and WorkManager instead.

## Build

1. Open the `android` folder in Android Studio (JDK 17 and Android SDK 35), or run `./gradlew :app:assembleDebug`.
2. In `gradle.properties`, set `WEB_APP_URL` to the HTTPS address of the deployed app.
3. Use **Build > Generate Signed Bundle / APK** to produce a signed release. Supply `VERSION_NAME` and an ever-increasing `VERSION_CODE`, then run `./gradlew :app:packageReleaseApk :app:exportPlayBundle`. Its distribution outputs are `IŠRM-<VERSION_NAME>.apk` (direct download) and `IŠRM-<VERSION_NAME>.aab` (Google Play upload).

The widget configuration screen supports a next-lesson card and a whole-day layout. It reads the same local cache as the app when offline. Only while at least one widget exists, it uses a network-constrained WorkManager refresh every six hours; the app itself does not run a repeating background task. Android may delay background work under battery-saving rules, and tapping the widget refresh control triggers an immediate refresh. The merged AndroidX worker manifest adds standard network and background-scheduling permissions; the app requests no location, contacts, camera, files, or notification access.

## Public release

The repository includes `.github/workflows/android-release.yml`. Create a signing keystore outside the repository and add these GitHub Actions secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Creating a tag such as `v1.1` builds a signed release asset named `IŠRM-1.1.apk` and attaches it to that GitHub Release (GitHub stores it as `ISRM-1.1.apk`, without the Š).

After GitHub publishes the asset, set these values in the server `.env`, then run `docker compose up -d --build`:

```env
ANDROID_APP_VERSION=1.1
ANDROID_APK_URL=https://github.com/majmohar4/isrm-urnik/releases/download/v1.1/ISRM-1.1.apk
ANDROID_RELEASE_URL=https://isrm.majmohar.eu/android
```

Android visitors to the website are offered the native APK instead of the PWA. The app checks `/api/release` on launch; if its installed version is older, it opens `/android?installed=<version>`. That stable update page compares versions and offers the current signed APK. Android requires a user confirmation before installing an APK, so neither the website nor the app silently installs it.

## Play Store and security

The direct GitHub APK is signed, but Android can still show an installation warning for every app installed from a browser. That warning identifies a **sideloaded source**; it cannot be removed by code in the app. Do not promise users otherwise.

For the normal, store-verified experience, upload the signed `IŠRM-<VERSION_NAME>.aab` to Google Play Console and use [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756). The GitHub workflow now creates that AAB as a private workflow artifact for each tag. Keep the package id (`eu.majmohar.isrm`), upload key, and signing lineage stable; a lost signing key prevents updates to existing direct installs.

Before submitting a Play release:

1. Upload the AAB to internal testing first and resolve every Play pre-launch report issue.
2. Complete the Data safety declaration from the behavior of the submitted build, and link the public policy at `https://isrm.majmohar.eu/privacy`.
3. Publish a truthful store listing, developer contact email, screenshots, and a release note. Do not claim automatic or silent APK installation.
4. Keep Android, Gradle dependencies, and the signing key current. Review the release APK with `apkanalyzer` or Android Studio before publishing.

The app deliberately has a small permission surface: only `INTERNET` is declared by the app itself; backups are disabled; clear-text HTTP is forbidden by both the manifest and network-security configuration; and release builds are R8-minified and resource-shrunk. Its fixed production endpoint must therefore be HTTPS. These controls reduce risk but do not override Google Play's independent review or Play Protect decisions.
