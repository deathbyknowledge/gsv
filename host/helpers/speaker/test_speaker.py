import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch, sentinel

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
    def test_failed_output_construction_releases_context_immediately(self):
        def fail(stream, **_options):
            stream._context = sentinel.context
            raise RuntimeError("device unavailable")
        with patch.object(helper.miniaudio.PlaybackDevice, "__init__", fail), \
                patch.object(helper.miniaudio.PlaybackDevice, "close") as close_device, \
                patch.object(helper.miniaudio, "lib") as lib:
            with self.assertRaisesRegex(RuntimeError, "device unavailable"):
                helper.SharedOutput()
            self.assertTrue(close_device.called)
            lib.ma_context_uninit.assert_called_once_with(sentinel.context)

    def test_output_releases_context_once_after_device_including_partial_init(self):
        with patch.object(helper.miniaudio.PlaybackDevice, "__init__", return_value=None), \
                patch.object(helper.miniaudio.PlaybackDevice, "close") as close_device, \
                patch.object(helper.miniaudio, "lib") as lib:
            stream = helper.SharedOutput()
            stream.close()
            lib.ma_context_uninit.assert_not_called()
            stream._context = sentinel.context
            lib.ma_context_uninit.side_effect = lambda _: self.assertTrue(close_device.called)
            stream.close()
            stream.close()
            lib.ma_context_uninit.assert_called_once_with(sentinel.context)
            self.assertIsNone(stream._context)
            del stream

    def test_playback_uses_only_the_shared_backend(self):
        speaker = Speaker(None)
        try:
            with patch.object(helper, "SharedOutput") as factory:
                speaker.append(0, "test", np.ones(100, dtype=np.float32))
                self.assertEqual(factory.call_args.kwargs["backends"], [helper.OUTPUT_BACKEND])
                self.assertNotIn(helper.OUTPUT_BACKEND,
                                 (helper.miniaudio.Backend.ALSA, helper.miniaudio.Backend.NULL))
                # Starting the device may synchronously ask for samples on another thread.
                callback = factory.return_value.start.call_args.args[0]
                output = callback.send(480)
                self.assertTrue(np.all(output[:100] == 1))
                self.assertTrue(np.all(output[100:] == 0))
        finally:
            speaker.close()

    @unittest.skipUnless(sys.platform == "linux", "Linux audio server selection")
    def test_unavailable_audio_server_fails_without_hardware_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            env = dict(os.environ, PULSE_SERVER="unix:" + str(Path(directory) / "missing.sock"))
            result = subprocess.run([sys.executable, "-c", """
import speaker
assert speaker.OUTPUT_BACKEND == speaker.miniaudio.Backend.PULSEAUDIO
try:
    device = speaker.SharedOutput(backends=[speaker.OUTPUT_BACKEND])
except speaker.miniaudio.MiniaudioError:
    pass
else:
    device.close()
    raise AssertionError('unexpected audio fallback')
"""], cwd=Path(__file__).parent, env=env, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_idle_playback_releases_output_and_next_reply_opens_a_new_stream(self):
        speaker = Speaker(None)
        first, second = Mock(), Mock()
        try:
            with patch.object(helper, "SharedOutput", side_effect=[first, second]):
                speaker.append(0, "first", np.ones(100, dtype=np.float32))
                speaker.append(0, "first", None)
                output = np.empty((480, 1), dtype=np.float32)
                speaker.output(output, 480)
                speaker.release_idle_output()
                first.close.assert_not_called()
                with speaker.condition:
                    speaker.last_output -= 1
                speaker.release_idle_output()
                first.stop.assert_called_once()
                first.close.assert_called_once()
                self.assertIsNone(speaker.stream)
                speaker.append(0, "second", np.ones(100, dtype=np.float32))
                second.start.assert_called_once()
        finally:
            speaker.close()

    def test_output_stays_open_between_chunks_of_a_reply(self):
        speaker = Speaker(None)
        stream = Mock()
        speaker.stream = stream
        try:
            speaker.append(0, "reply", np.ones(100, dtype=np.float32))
            output = np.empty((480, 1), dtype=np.float32)
            speaker.output(output, 480)
            with speaker.condition:
                speaker.last_output -= 1
            speaker.release_idle_output()
            stream.close.assert_not_called()
        finally:
            speaker.close()

    def test_full_playback_queue_does_not_block_cancellation(self):
        speaker = Speaker(None)
        speaker.stream = Mock()
        try:
            for _ in range(3):
                speaker.append(0, "old", np.ones(100, dtype=np.float32))
            result = []
            producer = threading.Thread(target=lambda: result.append(
                speaker.append(0, "old", np.ones(100, dtype=np.float32))), daemon=True)
            producer.start()
            speaker.cancel()
            producer.join(timeout=2)
            self.assertFalse(producer.is_alive())
            self.assertEqual(result, [False])
        finally:
            speaker.close()

    def test_cancel_acknowledges_only_after_stopping_and_closing_output(self):
        speaker = Speaker(None)
        stream = Mock()
        speaker.stream = stream
        try:
            with patch.object(helper, "emit") as emit:
                def stopped(*_args, **_kwargs):
                    emit.assert_not_called()
                stream.stop.side_effect = stopped
                stream.close.side_effect = stopped
                speaker.command({"kind": "cancel", "id": "stop-one"})
                stream.stop.assert_called_once_with()
                stream.close.assert_called_once()
                self.assertIsNone(speaker.stream)
                emit.assert_called_once_with("idle", "stop-one")
        finally:
            speaker.close()

    def test_cancel_failure_is_correlated_and_still_closes_output(self):
        speaker = Speaker(None)
        stream = Mock()
        stream.stop.side_effect = RuntimeError("private device details")
        speaker.stream = stream
        try:
            with patch.object(helper, "emit") as emit:
                speaker.command({"kind": "cancel", "id": "stop-one"})
                stream.close.assert_called_once()
                emit.assert_called_once_with("error", "stop-one", "RuntimeError")
        finally:
            speaker.close()

    def test_failed_output_start_closes_the_stream_and_retry_plays(self):
        failed = Mock()
        failed.start.side_effect = RuntimeError("output unavailable")
        recovered = Mock()
        speaker = Speaker(None)
        samples = np.ones(100, dtype=np.float32)
        try:
            with patch.object(helper, "SharedOutput", side_effect=[failed, recovered]):
                with self.assertRaisesRegex(RuntimeError, "output unavailable"):
                    speaker.append(0, "failed", samples)
                failed.close.assert_called_once()
                self.assertIsNone(speaker.stream)
                self.assertFalse(speaker.audio)
                self.assertTrue(speaker.append(0, "retry", samples))
                self.assertTrue(speaker.append(0, "retry", None))
                recovered.start.assert_called_once()
                output = np.empty((480, 1), dtype=np.float32)
                speaker.output(output, 480)
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
            speaker.output(output, 480)
            self.assertTrue(np.all(output == 1))
            speaker.cancel()
            speaker.output(output, 480)
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
            speaker.stream = Mock()
            speaker.command({"kind": "speak", "id": "new", "language": "en", "chunks": ["new"]})
            release.set()
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                with speaker.condition:
                    if len(speaker.audio) == 2:
                        break
                time.sleep(.005)
            output = np.empty((480, 1), dtype=np.float32)
            speaker.output(output, 480)
            self.assertTrue(np.all(output[:100] == 2))
            self.assertTrue(np.all(output[100:] == 0))
        finally:
            release.set()
            speaker.close()


if __name__ == "__main__":
    unittest.main()
