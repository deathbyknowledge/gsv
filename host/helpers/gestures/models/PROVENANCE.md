# Gesture model provenance

GSV embeds the palm detector and hand landmark detector extracted from Google's
MediaPipe Gesture Recognizer float16 version 1 bundle. GSV does not embed or
execute the bundled canned gesture classifier.

- Source bundle: <https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task>
- Source bundle SHA-256: `97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482`
- Model card: <https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021.pdf>
- License: Apache License 2.0, reproduced in `LICENSE.apache-2.0`

Extracted files:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `hand_detector.tflite` | 2,339,878 | `60d1bf8d70a80aba35b36290bb2a0e52e784ca2e524937d49ea80e8161a8a384` |
| `hand_landmarks_detector.tflite` | 5,478,949 | `6acda74af3fbf40e68265c20c7394b2bad81a16a481dcd79ad7a081887c3d6b9` |

`scripts/vision-native/update-models.sh` reproduces the extraction and verifies
the source bundle and both outputs before replacing these vendored files.
