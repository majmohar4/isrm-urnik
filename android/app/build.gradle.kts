import java.time.LocalDate

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

val appVersionName = providers.gradleProperty("VERSION_NAME").getOrElse("1.6")
// Same rule as the release workflow: 1.7 -> 10700, 1.7.2 -> 10702, unless VERSION_CODE is given explicitly.
val appVersionCode = providers.gradleProperty("VERSION_CODE").orNull?.toInt()
    ?: appVersionName.split('.').map { it.toIntOrNull() ?: 0 }.let { it.getOrElse(0) { 0 } * 10000 + it.getOrElse(1) { 0 } * 100 + it.getOrElse(2) { 0 } }
val releaseStoreFile = providers.gradleProperty("RELEASE_STORE_FILE").orNull
val releaseStorePassword = providers.gradleProperty("RELEASE_STORE_PASSWORD").orNull
val releaseKeyAlias = providers.gradleProperty("RELEASE_KEY_ALIAS").orNull
val releaseKeyPassword = providers.gradleProperty("RELEASE_KEY_PASSWORD").orNull

android {
    namespace = "eu.majmohar.isrm"
    compileSdk = 35
    defaultConfig {
        applicationId = "eu.majmohar.isrm"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        // Shown in the app as "posodobljeno"; fixed at build time so it says when this APK was made.
        buildConfigField("String", "BUILD_DATE", "\"${LocalDate.now()}\"")
        buildConfigField("String", "WEB_APP_URL", "\"${providers.gradleProperty("WEB_APP_URL").getOrElse("https://isrm.majmohar.eu")}\"")
    }
    signingConfigs {
        if (releaseStoreFile != null && releaseStorePassword != null && releaseKeyAlias != null && releaseKeyPassword != null) {
            create("release") {
                storeFile = file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.register<Copy>("packageReleaseApk") {
    dependsOn("assembleRelease")
    from(layout.buildDirectory.dir("outputs/apk/release")) { include("*.apk") }
    into(layout.buildDirectory.dir("outputs/distribution"))
    rename { "IŠRM-${appVersionName}.apk" }
}

tasks.register<Copy>("exportPlayBundle") {
    dependsOn("bundleRelease")
    from(layout.buildDirectory.dir("outputs/bundle/release")) { include("*.aab") }
    into(layout.buildDirectory.dir("outputs/distribution"))
    rename { "IŠRM-${appVersionName}.aab" }
}

kotlin { jvmToolchain(17) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.dynamicanimation:dynamicanimation:1.0.0")
}
