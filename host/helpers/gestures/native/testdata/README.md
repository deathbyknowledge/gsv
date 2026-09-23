# Native model regression outputs

These little-endian FP32 outputs come from `ai-edge-litert==2.2.0` with
XNNPACK and one CPU thread. They exercise both unchanged, checksum-pinned
gesture models. Input element `i` is `(i % 256) / 255.0` in FP32, with shape
`[1, 192, 192, 3]` for palms and `[1, 224, 224, 3]` for landmarks. Outputs are
concatenated in model output order. No camera data is used.

The Rust regression test checks every output with one, two and four XNNPACK
threads. Absolute tolerances are 0.002 for palm outputs and image coordinates,
and 0.00002 for presence, handedness and world coordinates, matching the browser
feasibility checks.

After installing `scripts/vision-native/litert-requirements.txt` in a disposable
virtual environment, deliberately regenerate from the repository root with:

```bash
python scripts/vision-native/litert-reference.py \
  host/helpers/gestures/native/testdata --model-goldens
```

Ordinary builds and tests read these files without Python or network access.
