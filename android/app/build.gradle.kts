plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.tachicoma.lifegame.companion"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.tachicoma.lifegame.companion"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }

    testOptions {
        // Robolectric は実機ではなく JVM 上で画面を組み立てるので、テーマや文字列を
        // 解決するのに merged resources が要る。これが false だと画面のテストは
        // 「リソースが見つからない」で落ちる。
        unitTests.isIncludeAndroidResources = true

        // gradle は既定だとテスト名を出さないので、CI のログからは「何件通ったか」も
        // 「そもそも実行されたか」も読めない。画面のテストは黙って0件になっても
        // 緑のままなので、走った証拠をログに残す。
        unitTests.all { test ->
            test.testLogging {
                events("passed", "skipped", "failed")
            }
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.10.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")

    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")

    implementation("androidx.health.connect:connect-client:1.1.0")

    testImplementation("junit:junit:4.13.2")

    // 画面のテストは JVM 上 (Robolectric) で回す。実機・エミュレータを CI に用意すると
    // androidTest 一式と AVD の起動時間を抱えることになるので、そこまでは要らない。
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation("androidx.test.ext:junit:1.2.1")
    testImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
