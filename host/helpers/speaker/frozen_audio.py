"""Resolve sounddevice's ctypes lookup to the audio library in the frozen bundle."""

import ctypes.util
from pathlib import Path
import sys

runtime = Path(sys._MEIPASS)
library = runtime / {
    "linux": "libportaudio.so.2",
    "darwin": "_sounddevice_data/portaudio-binaries/libportaudio.dylib",
    "win32": "_sounddevice_data/portaudio-binaries/libportaudio64bit.dll",
}[sys.platform]
if not library.is_file():
    raise RuntimeError("The bundled audio library is missing.")
original_find_library = ctypes.util.find_library


def find_library(name):
    return str(library) if name == "portaudio" else original_find_library(name)


ctypes.util.find_library = find_library
