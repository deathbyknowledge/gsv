@file:Suppress("OVERRIDE_DEPRECATION")

package com.humansandmachines.gsv.wear.ui

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Bundle
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.humansandmachines.gsv.wear.audio.normalizeVoiceLevel
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.sqrt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

internal class DebugSpeechSamplePlayer(context: Context) : Closeable {
    private val applicationContext = context.applicationContext
    private val closed = AtomicBoolean(false)

    @Volatile
    private var activeEngine: TextToSpeech? = null

    @Volatile
    private var activeTrack: AudioTrack? = null

    suspend fun playLoop(onLevel: (Float) -> Unit) = withContext(Dispatchers.IO) {
        val sample = synthesizeSample()
        while (!closed.get()) {
            currentCoroutineContext().ensureActive()
            playSample(sample, onLevel)
            if (!closed.get()) delay(LOOP_PAUSE_MILLIS)
        }
    }

    override fun close() {
        closed.set(true)
        activeEngine?.let { engine ->
            runCatching { engine.stop() }
            runCatching { engine.shutdown() }
        }
        activeTrack?.let { track ->
            runCatching { track.stop() }
        }
    }

    private suspend fun synthesizeSample(): PcmSample {
        if (closed.get()) throw CancellationException("Speech review stopped")
        val output = File.createTempFile("gsv-speaking-review-", ".wav", applicationContext.cacheDir)
        val engine = createEngine()
        activeEngine = engine
        try {
            if (closed.get()) throw CancellationException("Speech review stopped")
            engine.setLanguage(Locale.US)
            engine.setSpeechRate(0.96f)
            engine.setPitch(0.94f)
            return synthesizePcm(engine, output)
        } finally {
            if (activeEngine === engine) activeEngine = null
            runCatching { engine.shutdown() }
            output.delete()
        }
    }

    private suspend fun createEngine(): TextToSpeech = withContext(Dispatchers.Main.immediate) {
        suspendCancellableCoroutine { continuation ->
            lateinit var engine: TextToSpeech
            engine = TextToSpeech(applicationContext) { status ->
                if (!continuation.isActive) {
                    engine.shutdown()
                } else if (status == TextToSpeech.SUCCESS) {
                    continuation.resume(engine)
                } else {
                    engine.shutdown()
                    continuation.resumeWithException(IllegalStateException("Text to speech is unavailable"))
                }
            }
            continuation.invokeOnCancellation {
                runCatching { engine.shutdown() }
            }
        }
    }

    private suspend fun synthesizePcm(engine: TextToSpeech, output: File): PcmSample =
        suspendCancellableCoroutine { continuation ->
            val utteranceId = UUID.randomUUID().toString()
            val lock = Any()
            val completed = AtomicBoolean(false)
            val audio = ByteArrayOutputStream()
            var sampleRate = 0
            var encoding = AudioFormat.ENCODING_INVALID
            var channelCount = 0

            fun fail(message: String) {
                if (completed.compareAndSet(false, true) && continuation.isActive) {
                    continuation.resumeWithException(IllegalStateException(message))
                }
            }

            engine.setOnUtteranceProgressListener(
                object : UtteranceProgressListener() {
                    override fun onStart(id: String) = Unit

                    override fun onBeginSynthesis(
                        id: String,
                        sampleRateInHz: Int,
                        audioFormat: Int,
                        channels: Int,
                    ) {
                        if (id != utteranceId) return
                        synchronized(lock) {
                            sampleRate = sampleRateInHz
                            encoding = audioFormat
                            channelCount = channels
                        }
                    }

                    override fun onAudioAvailable(id: String, chunk: ByteArray) {
                        if (id != utteranceId) return
                        synchronized(lock) {
                            audio.write(chunk, 0, chunk.size)
                        }
                    }

                    override fun onDone(id: String) {
                        if (id != utteranceId || !completed.compareAndSet(false, true)) return
                        val sample = synchronized(lock) {
                            PcmSample(
                                bytes = audio.toByteArray(),
                                sampleRate = sampleRate,
                                encoding = encoding,
                                channelCount = channelCount,
                            )
                        }
                        if (!sample.isSupported() || sample.bytes.isEmpty()) {
                            if (continuation.isActive) {
                                continuation.resumeWithException(
                                    IllegalStateException("Text to speech returned unsupported audio"),
                                )
                            }
                        } else if (continuation.isActive) {
                            continuation.resume(sample)
                        }
                    }

                    override fun onError(id: String) {
                        if (id == utteranceId) fail("Text to speech synthesis failed")
                    }

                    override fun onError(id: String, errorCode: Int) {
                        if (id == utteranceId) fail("Text to speech synthesis failed ($errorCode)")
                    }

                    override fun onStop(id: String, interrupted: Boolean) {
                        if (id == utteranceId) fail("Text to speech synthesis stopped")
                    }
                },
            )
            continuation.invokeOnCancellation {
                completed.set(true)
                runCatching { engine.stop() }
            }
            val result = engine.synthesizeToFile(
                REVIEW_PHRASE,
                Bundle(),
                output,
                utteranceId,
            )
            if (result != TextToSpeech.SUCCESS) fail("Text to speech synthesis could not start")
        }

    private suspend fun playSample(sample: PcmSample, onLevel: (Float) -> Unit) {
        val track = sample.createTrack()
        activeTrack = track
        try {
            if (closed.get()) return
            var written = 0
            while (written < sample.alignedByteCount) {
                currentCoroutineContext().ensureActive()
                val count = track.write(
                    sample.bytes,
                    written,
                    sample.alignedByteCount - written,
                    AudioTrack.WRITE_BLOCKING,
                )
                if (count <= 0) throw IllegalStateException("Speech review audio could not be written")
                written += count
            }
            if (closed.get()) return

            track.play()
            val totalFrames = written / sample.frameSizeBytes
            val levelWindowFrames = (sample.sampleRate * LEVEL_INTERVAL_MILLIS / 1_000)
                .coerceAtLeast(1)
            val timeoutAt = SystemClock.elapsedRealtime() +
                totalFrames * 1_000L / sample.sampleRate + PLAYBACK_GRACE_MILLIS
            while (!closed.get()) {
                currentCoroutineContext().ensureActive()
                val playbackFrame = track.playbackHeadPosition.toLong() and 0xffffffffL
                if (playbackFrame >= totalFrames || SystemClock.elapsedRealtime() >= timeoutAt) break
                val endFrame = minOf(totalFrames.toLong(), playbackFrame + levelWindowFrames)
                onLevel(sample.level(playbackFrame.toInt(), endFrame.toInt()))
                delay(LEVEL_INTERVAL_MILLIS)
            }
        } finally {
            runCatching { onLevel(0f) }
            runCatching { track.stop() }
            track.release()
            if (activeTrack === track) activeTrack = null
        }
    }

    private data class PcmSample(
        val bytes: ByteArray,
        val sampleRate: Int,
        val encoding: Int,
        val channelCount: Int,
    ) {
        val bytesPerSample: Int
            get() = when (encoding) {
                AudioFormat.ENCODING_PCM_8BIT -> 1
                AudioFormat.ENCODING_PCM_16BIT -> 2
                AudioFormat.ENCODING_PCM_FLOAT -> 4
                else -> 0
            }

        val frameSizeBytes: Int
            get() = bytesPerSample * channelCount

        val alignedByteCount: Int
            get() = bytes.size - bytes.size % frameSizeBytes

        fun isSupported(): Boolean =
            sampleRate > 0 &&
                channelCount in 1..2 &&
                bytesPerSample > 0

        fun createTrack(): AudioTrack {
            val channelMask = if (channelCount == 1) {
                AudioFormat.CHANNEL_OUT_MONO
            } else {
                AudioFormat.CHANNEL_OUT_STEREO
            }
            return AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(encoding)
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelMask)
                        .build(),
                )
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(alignedByteCount)
                .build()
                .also { track ->
                    if (
                        track.state != AudioTrack.STATE_INITIALIZED &&
                        track.state != AudioTrack.STATE_NO_STATIC_DATA
                    ) {
                        track.release()
                        throw IllegalStateException("Speech review audio is unavailable")
                    }
                }
        }

        fun level(startFrame: Int, endFrame: Int): Float {
            var squares = 0.0
            var sampleCount = 0
            var byteIndex = startFrame * frameSizeBytes
            val endByte = minOf(alignedByteCount, endFrame * frameSizeBytes)
            while (byteIndex < endByte) {
                val normalized = when (encoding) {
                    AudioFormat.ENCODING_PCM_8BIT ->
                        ((bytes[byteIndex].toInt() and 0xff) - 128) / 128.0
                    AudioFormat.ENCODING_PCM_16BIT -> {
                        val low = bytes[byteIndex].toInt() and 0xff
                        val high = bytes[byteIndex + 1].toInt()
                        ((high shl 8) or low).toShort() / 32768.0
                    }
                    AudioFormat.ENCODING_PCM_FLOAT -> {
                        val bits = (bytes[byteIndex].toInt() and 0xff) or
                            ((bytes[byteIndex + 1].toInt() and 0xff) shl 8) or
                            ((bytes[byteIndex + 2].toInt() and 0xff) shl 16) or
                            (bytes[byteIndex + 3].toInt() shl 24)
                        Float.fromBits(bits).coerceIn(-1f, 1f).toDouble()
                    }
                    else -> 0.0
                }
                squares += normalized * normalized
                sampleCount += 1
                byteIndex += bytesPerSample
            }
            if (sampleCount == 0) return 0f
            return normalizeVoiceLevel(sqrt(squares / sampleCount))
        }
    }

    private companion object {
        const val REVIEW_PHRASE =
            "The signal is clear. Your assistant is connected and ready to respond."
        const val LEVEL_INTERVAL_MILLIS = 40L
        const val LOOP_PAUSE_MILLIS = 720L
        const val PLAYBACK_GRACE_MILLIS = 1_000L
    }
}
