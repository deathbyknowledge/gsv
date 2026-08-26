# GSV tract-tflite patch

This directory vendors `tract-tflite` 0.23.4 from crates.io. The upstream
crate declares the `MIT OR Apache-2.0` license in its preserved Cargo metadata.

GSV adds TFLite import support for the operations used by MediaPipe's pinned
gesture-recognizer models:

- float16-to-float32 `DEQUANTIZE`
- `PRELU`
- statically sized NHWC `RESIZE_BILINEAR`
- `GATHER` with no batch dimensions
- `UNPACK`
- negative reduction axes
- floating-point `MEAN` without quantization rounding

The execution implementations already exist in tract-core; the local changes
only translate their TFLite representations into tract graphs. Keep the patch
generic and covered by the real four-model load test in the gesture helper.
