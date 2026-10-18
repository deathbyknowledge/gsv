# Local speech dependencies

`gsv-speak` includes CPython, Kokoro ONNX, ONNX Runtime, NumPy, sounddevice,
PortAudio, eSpeak NG and phonemizer, together with their dependencies. Users do
not need a Python installation. PyInstaller is used to build the executable;
its bootloader carries an exception permitting distribution of bundled programs.
The build appends the installed packages' license and notice files below.

- Kokoro ONNX (MIT): https://github.com/thewh1teagle/kokoro-onnx
- ONNX Runtime (MIT): https://github.com/microsoft/onnxruntime
- NumPy (BSD): https://github.com/numpy/numpy
- sounddevice and PortAudio (MIT): https://github.com/spatialaudio/python-sounddevice
  and https://github.com/PortAudio/portaudio
- eSpeak NG (GPL-3.0-or-later): https://github.com/espeak-ng/espeak-ng
- phonemizer (GPL-3.0-or-later): https://github.com/bootphon/phonemizer
- CPython (PSF): https://github.com/python/cpython
- PyInstaller (GPL-2.0-or-later with bootloader exception): https://github.com/pyinstaller/pyinstaller

The Kokoro 82M model and voices (Apache-2.0) are downloaded separately on first
use from the pinned, checksum-verified release in `host/helpers/speaker/prepare.py`.
Model source and license: https://huggingface.co/hexgrad/Kokoro-82M.
The exact Python dependency versions and source distributions are recorded in
`host/helpers/speaker/uv.lock` in the matching Ship source release.
