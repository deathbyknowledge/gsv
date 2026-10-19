import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import prepare


class ModelPreparation(unittest.TestCase):
    def test_download_is_verified_cached_and_repaired(self):
        content = b"pinned model"
        files = [("model.onnx", "model.onnx", hashlib.sha256(content).hexdigest(), "model.onnx")]
        with tempfile.TemporaryDirectory() as temporary, patch.object(prepare, "FILES", files), \
                patch.dict(prepare.os.environ, {"GSV_SPEAK_MODEL_SOURCE_DIR": ""}):
            directory = Path(temporary)
            with patch.object(prepare.urllib.request, "urlopen", return_value=io.BytesIO(content)) as download:
                prepare.prepare_model(directory)
                prepare.prepare_model(directory)
                download.assert_called_once()
            self.assertEqual((directory / "model.onnx").read_bytes(), content)
            (directory / "model.onnx").write_bytes(b"corrupted")
            with patch.object(prepare.urllib.request, "urlopen", return_value=io.BytesIO(content)):
                prepare.prepare_model(directory)
            self.assertEqual((directory / "model.onnx").read_bytes(), content)
            with patch.object(prepare.urllib.request, "urlopen", return_value=io.BytesIO(b"wrong")):
                (directory / "model.onnx").unlink()
                with self.assertRaises(ValueError):
                    prepare.prepare_model(directory)
            self.assertEqual(list(directory.iterdir()), [])

    def test_cancelled_download_does_not_publish_or_leave_a_partial_file(self):
        content = b"pinned model"
        files = [("model.onnx", "model.onnx", hashlib.sha256(content).hexdigest(), "model.onnx")]
        with tempfile.TemporaryDirectory() as temporary, patch.object(prepare, "FILES", files), \
                patch.object(prepare.urllib.request, "urlopen", return_value=io.BytesIO(content)), \
                patch.dict(prepare.os.environ, {"GSV_SPEAK_MODEL_SOURCE_DIR": ""}):
            checks = iter([False, True])
            with self.assertRaises(prepare.PreparationCancelled):
                prepare.prepare_model(Path(temporary), lambda: next(checks))
            self.assertEqual(list(Path(temporary).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
