# Local speech dependencies

`gsv-speak` includes CPython, Kokoro ONNX, ONNX Runtime, NumPy, miniaudio,
eSpeak NG and phonemizer, together with their dependencies. Users do
not need a Python installation. PyInstaller is used to build the executable;
its bootloader carries an exception permitting distribution of bundled programs.
The build appends the installed packages' license and notice files below.

- Kokoro ONNX (MIT): https://github.com/thewh1teagle/kokoro-onnx
- ONNX Runtime (MIT): https://github.com/microsoft/onnxruntime
- NumPy (BSD): https://github.com/numpy/numpy
- pyminiaudio and miniaudio (MIT): https://github.com/irmen/pyminiaudio
  and https://github.com/mackron/miniaudio
- eSpeak NG (GPL-3.0-or-later): https://github.com/espeak-ng/espeak-ng
- espeakng-loader (MIT): https://github.com/thewh1teagle/espeakng-loader
- phonemizer (GPL-3.0-or-later): https://github.com/bootphon/phonemizer
- CPython (PSF): https://github.com/python/cpython
- PyInstaller (GPL-2.0-or-later with bootloader exception): https://github.com/pyinstaller/pyinstaller

The Kokoro 82M model and voices (Apache-2.0) are downloaded separately on first
use from the pinned, checksum-verified release in `host/helpers/speaker/prepare.py`.
Model source and license: https://huggingface.co/hexgrad/Kokoro-82M.
The exact Python dependency versions and source distributions are recorded in
`host/helpers/speaker/uv.lock` in the matching Ship source release.

## Corresponding source

The binary's release page links to the exact Ship source commit and this source
index. The helper lives in `host/helpers/speaker/`; its packaging script is
`host/scripts/build-speaker.py`, and `.github/workflows/release.yml` records the
platform build commands. `uv.lock` records dependency versions, download URLs
and SHA-256 hashes.

The following upstream archives contain the source for the bundled GPL
components and their native-library packaging:

| Component | Source archive |
| --- | --- |
| eSpeak NG 1.52.0, including its dictionary and phoneme data sources | [commit 4870adfa25b1a32b4361592f1be8a40337c58d6c](https://codeload.github.com/espeak-ng/espeak-ng/tar.gz/4870adfa25b1a32b4361592f1be8a40337c58d6c) |
| espeakng-loader 0.2.4 | [commit 0ddc87adf77e5850d7eeb542ac8a87d421b64daa](https://codeload.github.com/thewh1teagle/espeakng-loader/tar.gz/0ddc87adf77e5850d7eeb542ac8a87d421b64daa) |
| phonemizer 3.4.0 | [PyPI source distribution](https://files.pythonhosted.org/packages/bc/7d/5a96ddb130552f6365a090b5fd12ace803a95a858e3f67258f2ad13dc51f/phonemizer-3.4.0.tar.gz) |

The loader archive contains the 0.2.4 packaging code plus the upstream MIT
license added afterward. Its `build.sh` and `.github/workflows/build.yml` describe
the eSpeak NG library and data builds; `.github/workflows/pypi.yml` describes
wheel assembly. Extract the eSpeak NG source into the loader's `espeak-ng/`
directory when rebuilding from these archives. Ship uses the upstream wheels
without patches to these components.

These links must be updated with dependency upgrades. Distributors must keep
the matching source available while offering the binaries; if an upstream
archive becomes unavailable, provide a mirror and update the download-page links.
The full GPLv3 text is included below with phonemizer's installed license.

## espeakng-loader license

MIT License

Copyright (c) 2025 thewh1teagle

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
