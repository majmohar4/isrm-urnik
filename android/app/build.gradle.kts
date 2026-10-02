plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

android {
    namespace = "eu.majmohar.isrm"
    compileSdk = 35
    defaultConfig {
        applicationId = "eu.majmohar.isrm"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "WEB_APP_URL", "\"${providers.gradleProperty("WEB_APP_URL").getOrElse("https://isrm.majmohar.eu")}\"")
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { jvmToolchain(17) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("com.google.android.material:material:1.12.0")
}
