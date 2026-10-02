# IŠRM Android

This is a fully native Android timetable. It stores timetable weeks locally, renders the schedule with Android views, refreshes in the background, and publishes a real Android home-screen widget. A PWA cannot provide an Android home-screen widget; this project uses `AppWidgetProvider` and WorkManager instead.

## Build

1. Open the `android` folder in Android Studio (JDK 17 and Android SDK 35), or run `./gradlew :app:assembleDebug`.
2. In `gradle.properties`, set `WEB_APP_URL` to the HTTPS address of the deployed app.
3. Use **Build > Generate Signed Bundle / APK** to produce a release APK or AAB.

The widget configuration screen supports a next-lesson card and a whole-day layout. It reads the same local cache as the app when offline, fetches `/api/timetable` when a connection is available, and refreshes via WorkManager at Android's 15-minute minimum interval. Android may delay background work under battery-saving rules; tapping its refresh control triggers an immediate refresh. The merged AndroidX worker manifest adds standard network and background-scheduling permissions; the app requests no location, contacts, camera, files, or notification access.

Set `ANDROID_APP_VERSION` and `ANDROID_APK_URL` on the server when publishing a signed APK. The native app checks `/api/release` on launch and shows an in-app update reminder for a newer version; it never silently installs software.

Before a Play Store release, complete the Play Console Data safety declaration using the public policy at `https://isrm.majmohar.eu/privacy` and the actual signed build's behavior.
