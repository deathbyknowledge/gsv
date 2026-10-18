import io
import json
import threading
import time
import unittest
from unittest.mock import Mock, patch

import numpy as np
import speaker as helper
from speaker import RATE, Speaker


class SpeakerProtocol(unittest.TestCase):
    def test_escaped_maximum_payload_reaches_the_speaker_and_keeps_reading(self):
        for character in ('"', '\\', '\x00'):
            with self.subTest(character=repr(character)):
                command = {"kind": "speak", "id": character * 256, "language": "en",
                           "chunks": [character * 512] * 256}
                line = json.dumps(command, separators=(',', ':')).encode() + b'\n'
                self.assertGreater(len(line), 256 * 1024)
                source = io.TextIOWrapper(io.BytesIO(line + b'{"kind":"cancel"}\n'))
                with source, patch.object(helper.sys, "stdin", source), \
                        patch.object(helper.sys, "argv", ["gsv-speak"]), \
                        patch.object(helper, "Speaker") as factory, patch.object(helper, "emit") as emit:
                    helper.main()
                    self.assertEqual([call.args[0] for call in factory.return_value.command.call_args_list],
                                     [command, {"kind": "cancel"}])
                    factory.return_value.close.assert_called_once()
                    emit.assert_called_once_with("idle")

    def test_oversized_line_is_rejected_before_dispatch(self):
        source = io.TextIOWrapper(io.BytesIO(b'x' * (helper.MAX_LINE + 1)))
        with source, patch.object(helper.sys, "stdin", source), \
                patch.object(helper.sys, "argv", ["gsv-speak"]), \
                patch.object(helper, "Speaker") as factory, patch.object(helper, "emit") as emit:
            helper.main()
            factory.return_value.command.assert_not_called()
            factory.return_value.close.assert_called_once()
            emit.assert_any_call("error", error="command_too_large")


class SpeakerPlayback(unittest.TestCase):
    def test_failed_output_start_closes_the_stream_and_retry_plays(self):
        failed = Mock()
        failed.start.side_effect = RuntimeError("output unavailable")
        recovered = Mock()
        speaker = Speaker(None)
        samples = np.ones(100, dtype=np.float32)
        try:
            with patch("sounddevice.OutputStream", side_effect=[failed, recovered]):
                with self.assertRaisesRegex(RuntimeError, "output unavailable"):
                    speaker.append(0, "failed", samples)
                failed.close.assert_called_once()
                self.assertIsNone(speaker.stream)
                self.assertFalse(speaker.audio)
                self.assertTrue(speaker.append(0, "retry", samples))
                self.assertTrue(speaker.append(0, "retry", None))
                recovered.start.assert_called_once()
                output = np.empty((480, 1), dtype=np.float32)
                speaker.output(output, 480, None, None)
                self.assertTrue(np.all(output[:100] == 1))
                self.assertTrue(np.all(output[100:] == 0))
                self.assertFalse(speaker.audio)
        finally:
            speaker.close()
        recovered.close.assert_called_once()

    def test_cancel_drops_buffered_audio_at_the_next_callback(self):
        speaker = Speaker(None)
        speaker.stream = Mock()
        try:
            speaker.append(0, "old", np.ones(2000, dtype=np.float32))
            output = np.empty((480, 1), dtype=np.float32)
            speaker.output(output, 480, None, None)
            self.assertTrue(np.all(output == 1))
            speaker.cancel()
            speaker.output(output, 480, None, None)
            self.assertTrue(np.all(output == 0))
            self.assertFalse(speaker.append(0, "old", np.ones(2000, dtype=np.float32)))
        finally:
            speaker.close()

    def test_inference_finishing_after_cancel_cannot_play_into_a_new_request(self):
        started = threading.Event()
        release = threading.Event()
        class Model:
            def create(self, text, **_options):
                if text == "old":
                    started.set()
                    release.wait(2)
                return np.full(100, 1 if text == "old" else 2, dtype=np.float32), RATE
        speaker = Speaker(None)
        speaker.model = Model()
        speaker.stream = Mock()
        try:
            speaker.command({"kind": "speak", "id": "old", "language": "en", "chunks": ["old"]})
            self.assertTrue(started.wait(2))
            speaker.cancel()
            speaker.command({"kind": "speak", "id": "new", "language": "en", "chunks": ["new"]})
            release.set()
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                with speaker.condition:
                    if len(speaker.audio) == 2:
                        break
                time.sleep(.005)
            output = np.empty((480, 1), dtype=np.float32)
            speaker.output(output, 480, None, None)
            self.assertTrue(np.all(output[:100] == 2))
            self.assertTrue(np.all(output[100:] == 0))
        finally:
            release.set()
            speaker.close()


if __name__ == "__main__":
    unittest.main()
