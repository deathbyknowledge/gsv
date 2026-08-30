plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val gestureHostDir = rootProject.layout.projectDirectory.dir("../host")
val gestureModelsDir = gestureHostDir.dir("helpers/gestures/models")
val gestureJniDir = layout.buildDirectory.dir("generated/gesture/jniLibs")
val visualShadersDir = rootProject.layout.projectDirectory.dir("../visuals/shaders")

val buildGestureNative by tasks.registering(Exec::class) {
    inputs.files(
        fileTree(gestureHostDir) {
            include("Cargo.toml", "Cargo.lock")
            include("crates/gesture-android/**")
            include("crates/gesture-engine/**")
            include("vendor/tract-tflite/**")
            exclude("target/**")
        },
    )
    outputs.dir(gestureJniDir)
    workingDir(gestureHostDir.asFile)
    commandLine(
        "cargo",
        "ndk",
        "-t",
        "arm64-v8a",
        "-P",
        "26",
        "-o",
        gestureJniDir.get().asFile.absolutePath,
        "build",
        "--package",
        "gesture-android",
        "--release",
    )
}

android {
    namespace = "com.humansandmachines.gsv.wear"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.humansandmachines.gsv.wear"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        aidl = true
        buildConfig = true
        compose = true
    }

    sourceSets {
        getByName("main") {
            assets.directories.add(gestureModelsDir.asFile.absolutePath)
            assets.directories.add(visualShadersDir.asFile.absolutePath)
            jniLibs.directories.add(gestureJniDir.get().asFile.absolutePath)
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.named("preBuild").configure {
    dependsOn(buildGestureNative)
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("androidx.camera:camera-camera2:1.6.1")
    implementation("androidx.camera:camera-lifecycle:1.6.1")
    implementation("androidx.core:core-ktx:1.18.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-service:2.11.0")
    val composeBom = platform("androidx.compose:compose-bom:2026.08.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)
    implementation("androidx.compose.animation:animation")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("com.squareup.okhttp3:okhttp:5.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("org.json:json:20250517")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.3.0")

    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
