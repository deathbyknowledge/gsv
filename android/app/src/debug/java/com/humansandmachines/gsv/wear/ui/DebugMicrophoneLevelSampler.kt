package com.humansandmachines.gsv.wear.ui

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import com.humansandmachines.gsv.wear.audio.normalizeVoiceLevel
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sqrt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

internal class DebugMicrophoneLevelSampler : Closeable {
    private val closed = AtomicBoolean(false)

    @Volatile
    private var activeRecorder: AudioRecord? = null

    @SuppressLint("MissingPermission")
    suspend fun sample(onLevel: (Float) -> Unit) = withContext(Dispatchers.IO) {
        if (closed.get()) return@withContext
        val minimumBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimumBuffer <= 0) return@withContext
        val recorder = initializedRecorder(MediaRecorder.AudioSource.VOICE_RECOGNITION, minimumBuffer)
            ?: initializedRecorder(MediaRecorder.AudioSource.MIC, minimumBuffer)
            ?: return@withContext
        activeRecorder = recorder
        try {
            if (closed.get()) return@withContext
            recorder.startRecording()
            if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) return@withContext
            val samples = ShortArray(FRAME_SAMPLES)
            var nextPublishAt = 0L
            while (!closed.get()) {
                currentCoroutineContext().ensureActive()
                val count = recorder.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
                if (count <= 0) {
                    if (closed.get()) break
                    continue
                }
                val now = SystemClock.elapsedRealtime()
                if (now < nextPublishAt) continue
                var frameSquares = 0.0
                for (index in 0 until count) {
                    val normalized = samples[index] / 32768.0
                    frameSquares += normalized * normalized
                }
                onLevel(normalizeVoiceLevel(sqrt(frameSquares / count)))
                nextPublishAt = now + LEVEL_PUBLISH_INTERVAL_MILLIS
            }
        } finally {
            runCatching { onLevel(0f) }
            runCatching {
                if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
            }
            recorder.release()
            if (activeRecorder === recorder) activeRecorder = null
        }
    }

    override fun close() {
        closed.set(true)
        activeRecorder?.let { recorder ->
            runCatching {
                if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun initializedRecorder(source: Int, minimumBuffer: Int): AudioRecord? {
        val recorder = runCatching {
            AudioRecord.Builder()
                .setAudioSource(source)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SAMPLE_RATE_HZ)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(maxOf(minimumBuffer, FRAME_SAMPLES * 4))
                .build()
        }.getOrNull() ?: return null
        if (recorder.state == AudioRecord.STATE_INITIALIZED) return recorder
        recorder.release()
        return null
    }

    private companion object {
        const val SAMPLE_RATE_HZ = 16_000
        const val FRAME_SAMPLES = 320
        const val LEVEL_PUBLISH_INTERVAL_MILLIS = 40L
    }
}
