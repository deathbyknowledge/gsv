# GSV Wear for Android

This Gradle project builds the native Android machine driver and Wear Mode
runtime. It currently supports persistent WebSocket reconnect, local
camera/microphone authority, runtime notification controls, status reads, and
one on-demand CameraX snapshot.

## Prerequisites

- JDK 17 or newer
- Android SDK Platform 36 and Build Tools 36.0.0
- A physical Android phone for the sensor acceptance flow
- A GSV Gateway WebSocket URL ending in `/ws`
- A driver-bound device token

Create the token once and copy the raw value when it is returned:

```bash
gsv auth token create --kind device --device pixel-10 --label "Pixel Wear"
```

The device id entered in the app must exactly match the token's `--device`
binding. Production builds require `wss://`; debug builds permit `ws://` for
local development.

If the SDK is not in its conventional location, create an untracked
`android/local.properties` containing:

```properties
sdk.dir=/absolute/path/to/android-sdk
```

## Build and install

```bash
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Open GSV Wear, enter the Gateway URL, username, exact device id, and token,
then press **Arm Wear Mode**. Grant camera, microphone, and notification
permissions. For dependable screen-off reconnect behavior, use the app's
Battery settings button and set GSV Wear to unrestricted battery use.

The token is encrypted with Android Keystore and never rendered back into the
form. Leaving the token field empty preserves the stored token.

## Read physical context

Once the target is online, use the ordinary GSV `Read` primitive:

```json
{
  "target": "pixel-10",
  "path": "/dev/wear/status"
}
```

```json
{
  "target": "pixel-10",
  "path": "/dev/camera/back/snapshot"
}
```

The camera node returns an `fs.read` image body. CameraX is closed before the
body is streamed, and the cached JPEG is deleted after the transfer reaches a
terminal outcome.

## Physical-device acceptance checklist

Run this on an actual phone before treating a release as sensor-validated:

1. Fresh-install the APK and provision a newly bound device token.
2. Arm from the visible activity and confirm the foreground notification says
   camera and microphone are off.
3. Turn the screen off and read `/dev/camera/back/snapshot`; confirm an image
   reaches the requesting GSV process and the Android privacy indicator appears
   only during capture.
4. Switch Wi-Fi to mobile data, wait for `CONNECTED`, and take another
   snapshot without touching or unlocking the phone.
5. Restart the Gateway and confirm the phone reconnects for a later request.
6. Cancel a snapshot while CameraX is opening and while its body is streaming;
   confirm no late result and no `gsv-wear-snapshot-*` cache file remains.
7. Pause and then disarm during capture; confirm both paths cancel active work
   and subsequent camera reads fail closed.
8. Reboot and force-stop the app; confirm Wear authority is not recreated.
9. Revoke camera permission and contend with another camera app; confirm the
   request fails without crashing or retaining media.
10. Exercise forced Doze and an overnight armed run with unrestricted battery
    use, recording reconnect latency and battery consumption.

There is intentionally no FCM path. A socket that closes is noticed and
reconnected manually by the foreground runtime. An in-flight request at the
moment of disconnect fails rather than being replayed with an uncertain
physical outcome.
