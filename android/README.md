# IŠRM Android

This is a fully native Android timetable. It stores timetable weeks locally, renders the schedule with Android views, refreshes in the background, and publishes a real Android home-screen widget. A PWA cannot provide an Android home-screen widget; this project uses `AppWidgetProvider` and WorkManager instead.

## Build

1. Open the `android` folder in Android Studio (JDK 17 and Android SDK 35), or run `./gradlew :app:assembleDebug`.
2. In `gradle.properties`, set `WEB_APP_URL` to the HTTPS address of the deployed app.
3. Use **Build > Generate Signed Bundle / APK** to produce a signed release APK. Supply `VERSION_NAME` and `VERSION_CODE`, then run `./gradlew :app:packageReleaseApk`; its distribution output is named `IŠRM-<VERSION_NAME>.apk`.

The widget configuration screen supports a next-lesson card and a whole-day layout. It reads the same local cache as the app when offline, fetches `/api/timetable` when a connection is available, and refreshes via WorkManager at Android's 15-minute minimum interval. Android may delay background work under battery-saving rules; tapping its refresh control triggers an immediate refresh. The merged AndroidX worker manifest adds standard network and background-scheduling permissions; the app requests no location, contacts, camera, files, or notification access.

## Public release

The repository includes `.github/workflows/android-release.yml`. Create a signing keystore outside the repository and add these GitHub Actions secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Creating a tag such as `v1.1` builds a signed release asset named `IŠRM-1.1.apk` and attaches it to that GitHub Release.

After GitHub publishes the asset, set these values in the server `.env`, then run `docker compose up -d --build`:

```env
ANDROID_APP_VERSION=1.1
ANDROID_APK_URL=https://github.com/OWNER/REPOSITORY/releases/download/v1.1/I%C5%A0RM-1.1.apk
ANDROID_RELEASE_URL=https://isrm.majmohar.eu/android
```

Android visitors to the website are offered the native APK instead of the PWA. The app checks `/api/release` on launch; if its installed version is older, it opens `/android?installed=<version>`. That stable update page compares versions and offers the current signed APK. Android requires a user confirmation before installing an APK, so neither the website nor the app silently installs it.

Before a Play Store release, complete the Play Console Data safety declaration using the public policy at `https://isrm.majmohar.eu/privacy` and the actual signed build's behavior.
