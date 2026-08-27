package com.humansandmachines.gsv.wear.audio

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioDeviceInfo
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import com.humansandmachines.gsv.wear.authority.AuthorityLease
import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.runtime.MicrophoneState
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.sqrt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class AudioCaptureFailure(message: String) : Exception(message)

class CapturedAudio internal constructor(
    val file: File,
    val analysis: JSONObject,
) : Closeable {
    private val closed = AtomicBoolean(false)

    val length: Long
        get() = file.length()

    override fun close() {
        if (closed.compareAndSet(false, true)) file.delete()
    }
}

interface WearMicrophone {
    suspend fun sample(lease: AuthorityLease, durationMillis: Long): CapturedAudio

    suspend fun observe(lease: AuthorityLease, durationMillis: Long): CapturedAudio

    suspend fun listenUntilSpeech(
        lease: AuthorityLease,
        timeoutMillis: Long,
        trailingMillis: Long,
        preferredDevice: AudioDeviceInfo? = null,
        onLevel: (Float) -> Unit = {},
    ): CapturedAudio
}

class AudioController(
    private val context: Context,
    private val authority: WearAuthority,
    private val onState: (MicrophoneState) -> Unit,
) : WearMicrophone, Closeable {
    private val captureMutex = Mutex()
    private val closed = AtomicBoolean(false)

    @Volatile
    private var currentRecord: AudioRecord? = null

    override suspend fun sample(lease: AuthorityLease, durationMillis: Long): CapturedAudio =
        record(lease, durationMillis, stopAfterSpeechMillis = null)

    override suspend fun observe(lease: AuthorityLease, durationMillis: Long): CapturedAudio =
        record(lease, durationMillis, stopAfterSpeechMillis = null)

    override suspend fun listenUntilSpeech(
        lease: AuthorityLease,
        timeoutMillis: Long,
        trailingMillis: Long,
        preferredDevice: AudioDeviceInfo?,
        onLevel: (Float) -> Unit,
    ): CapturedAudio {
        if (trailingMillis !in MIN_TRAILING_MILLIS..MAX_TRAILING_MILLIS) {
            throw AudioCaptureFailure("Speech trailing duration is out of range")
        }
        return record(
            lease,
            timeoutMillis,
            stopAfterSpeechMillis = trailingMillis,
            preferredDevice = preferredDevice,
            onLevel = onLevel,
        )
    }

    private suspend fun record(
        lease: AuthorityLease,
        durationMillis: Long,
        stopAfterSpeechMillis: Long?,
        preferredDevice: AudioDeviceInfo? = null,
        onLevel: (Float) -> Unit = {},
    ): CapturedAudio {
        if (durationMillis !in MIN_CAPTURE_MILLIS..MAX_CAPTURE_MILLIS) {
            throw AudioCaptureFailure("Microphone duration must be between $MIN_CAPTURE_MILLIS and $MAX_CAPTURE_MILLIS ms")
        }
        return captureMutex.withLock {
            withContext(Dispatchers.IO) {
                recordLocked(lease, durationMillis, stopAfterSpeechMillis, preferredDevice, onLevel)
            }
        }
    }

    private suspend fun recordLocked(
        lease: AuthorityLease,
        durationMillis: Long,
        stopAfterSpeechMillis: Long?,
        preferredDevice: AudioDeviceInfo?,
        onLevel: (Float) -> Unit,
    ): CapturedAudio {
        if (closed.get()) throw AudioCaptureFailure("Microphone controller is closed")
        if (
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            throw AudioCaptureFailure("Microphone permission is unavailable")
        }
        if (!authority.isCurrent(lease)) throw AudioCaptureFailure("Wear Mode is not armed")

        onState(MicrophoneState.OPENING)
        val minimumBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimumBuffer <= 0) {
            onState(MicrophoneState.CLOSED)
            throw AudioCaptureFailure("Microphone format is unavailable")
        }
        var recorder = runCatching {
            createAudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, minimumBuffer)
        }.getOrNull()
        if (recorder?.state != AudioRecord.STATE_INITIALIZED) {
            recorder?.release()
            recorder = runCatching { createAudioRecord(MediaRecorder.AudioSource.MIC, minimumBuffer) }.getOrNull()
        }
        val activeRecorder = recorder ?: run {
            onState(MicrophoneState.CLOSED)
            throw AudioCaptureFailure("Microphone could not be initialized")
        }
        if (activeRecorder.state != AudioRecord.STATE_INITIALIZED) {
            activeRecorder.release()
            onState(MicrophoneState.CLOSED)
            throw AudioCaptureFailure("Microphone could not be initialized")
        }
        preferredDevice?.let(activeRecorder::setPreferredDevice)

        val output = File.createTempFile("gsv-wear-audio-", ".wav", context.cacheDir)
        var keep = false
        currentRecord = activeRecorder
        try {
            val features = AudioFeatures()
            RandomAccessFile(output, "rw").use { wave ->
                wave.setLength(0)
                wave.write(ByteArray(WAV_HEADER_BYTES))
                activeRecorder.startRecording()
                if (activeRecorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                    throw AudioCaptureFailure("Microphone did not start recording")
                }
                onState(MicrophoneState.ACTIVE)

                val started = android.os.SystemClock.elapsedRealtime()
                val deadline = started + durationMillis
                var speechStopAt: Long? = null
                var nextLevelAt = started
                val samples = ShortArray(FRAME_SAMPLES)
                val bytes = ByteArray(FRAME_SAMPLES * 2)
                while (true) {
                    currentCoroutineContext().ensureActive()
                    if (!authority.isCurrent(lease)) {
                        throw AudioCaptureFailure("Wear Mode authority changed during microphone capture")
                    }
                    val now = android.os.SystemClock.elapsedRealtime()
                    if (now >= deadline || (speechStopAt != null && now >= speechStopAt)) break
                    val count = activeRecorder.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
                    if (count < 0) throw AudioCaptureFailure("Microphone read failed")
                    if (count == 0) continue
                    encodePcm(samples, count, bytes)
                    wave.write(bytes, 0, count * 2)
                    val elapsed = android.os.SystemClock.elapsedRealtime() - started
                    val frameSpeech = features.add(samples, count, elapsed)
                    if (now >= nextLevelAt) {
                        runCatching { onLevel(normalizeVoiceLevel(features.currentFrameRms)) }
                        nextLevelAt = now + LEVEL_PUBLISH_INTERVAL_MILLIS
                    }
                    if (stopAfterSpeechMillis != null && frameSpeech) {
                        speechStopAt = android.os.SystemClock.elapsedRealtime() + stopAfterSpeechMillis
                    }
                }
                val dataBytes = wave.length() - WAV_HEADER_BYTES
                writeWaveHeader(wave, dataBytes)
                val elapsed = android.os.SystemClock.elapsedRealtime() - started
                val timedOut = stopAfterSpeechMillis != null && !features.speechDetected
                val analysis = features.toJson(elapsed, timedOut)
                if (dataBytes <= 0) throw AudioCaptureFailure("Microphone returned no audio")
                keep = true
                return CapturedAudio(output, analysis)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: AudioCaptureFailure) {
            throw error
        } catch (_: SecurityException) {
            throw AudioCaptureFailure("Microphone permission is unavailable")
        } catch (_: Exception) {
            throw AudioCaptureFailure("Microphone capture failed")
        } finally {
            runCatching { onLevel(0f) }
            onState(MicrophoneState.CLOSING)
            runCatching {
                if (activeRecorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) activeRecorder.stop()
            }
            activeRecorder.release()
            currentRecord = null
            if (!keep) output.delete()
            onState(MicrophoneState.CLOSED)
        }
    }

    override fun close() {
        closed.set(true)
        runCatching { currentRecord?.stop() }
        onState(MicrophoneState.CLOSED)
    }

    @SuppressLint("MissingPermission")
    private fun createAudioRecord(source: Int, minimumBuffer: Int): AudioRecord = AudioRecord.Builder()
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

    private class AudioFeatures {
        private var sampleCount = 0L
        private var sumSquares = 0.0
        private var peak = 0
        private var maximumFrameRms = 0.0
        private var speechFrames = 0
        private var loudFrames = 0
        private var toneFrames = 0
        private var consecutiveSpeechFrames = 0
        private var firstSpeechAtMillis: Long? = null

        var currentFrameRms = 0.0
            private set

        val speechDetected: Boolean
            get() = firstSpeechAtMillis != null

        fun add(samples: ShortArray, count: Int, elapsedMillis: Long): Boolean {
            var frameSquares = 0.0
            var zeroCrossings = 0
            var previous = samples[0].toInt()
            for (index in 0 until count) {
                val value = samples[index].toInt()
                val absolute = abs(value)
                if (absolute > peak) peak = absolute
                val normalized = value / 32768.0
                val square = normalized * normalized
                sumSquares += square
                frameSquares += square
                if (index > 0 && (value >= 0) != (previous >= 0)) zeroCrossings += 1
                previous = value
            }
            sampleCount += count
            val rms = sqrt(frameSquares / count)
            currentFrameRms = rms
            val zeroCrossingRate = zeroCrossings.toDouble() / count
            maximumFrameRms = maxOf(maximumFrameRms, rms)
            val speechLike = rms >= SPEECH_RMS && zeroCrossingRate in 0.015..0.45
            if (speechLike) {
                speechFrames += 1
                consecutiveSpeechFrames += 1
            } else {
                consecutiveSpeechFrames = 0
            }
            if (rms >= LOUD_RMS) loudFrames += 1
            if (rms >= TONE_RMS && zeroCrossingRate in 0.02..0.18) toneFrames += 1
            if (firstSpeechAtMillis == null && consecutiveSpeechFrames >= SPEECH_FRAMES_REQUIRED) {
                firstSpeechAtMillis = elapsedMillis
            }
            return firstSpeechAtMillis != null && speechLike
        }

        fun toJson(durationMillis: Long, timedOut: Boolean): JSONObject {
            val averageRms = if (sampleCount == 0L) 0.0 else sqrt(sumSquares / sampleCount)
            val events = JSONArray()
            if (speechDetected) events.put("speech_or_voice")
            if (loudFrames >= 2) events.put("loud_sound")
            if (toneFrames >= 4) events.put("sustained_tone")
            return JSONObject()
                .put("durationMs", durationMillis)
                .put("sampleRateHz", SAMPLE_RATE_HZ)
                .put("channels", 1)
                .put("encoding", "pcm_s16le")
                .put("averageRms", averageRms)
                .put("maximumFrameRms", maximumFrameRms)
                .put("peak", peak / 32768.0)
                .put("speechDetected", speechDetected)
                .put("loudSoundDetected", loudFrames >= 2)
                .put("sustainedToneDetected", toneFrames >= 4)
                .put("events", events)
                .put("timedOut", timedOut)
                .apply { firstSpeechAtMillis?.let { put("firstSpeechAtMs", it) } }
        }
    }

    companion object {
        const val MIN_CAPTURE_MILLIS = 250L
        const val MAX_CAPTURE_MILLIS = 120_000L
        private const val MIN_TRAILING_MILLIS = 250L
        private const val MAX_TRAILING_MILLIS = 10_000L
        private const val SAMPLE_RATE_HZ = 16_000
        private const val FRAME_SAMPLES = 320
        private const val LEVEL_PUBLISH_INTERVAL_MILLIS = 50L
        private const val WAV_HEADER_BYTES = 44
        private const val SPEECH_RMS = 0.025
        private const val LOUD_RMS = 0.18
        private const val TONE_RMS = 0.04
        private const val SPEECH_FRAMES_REQUIRED = 3

        private fun encodePcm(samples: ShortArray, count: Int, bytes: ByteArray) {
            for (index in 0 until count) {
                val value = samples[index].toInt()
                bytes[index * 2] = (value and 0xff).toByte()
                bytes[index * 2 + 1] = ((value ushr 8) and 0xff).toByte()
            }
        }

        private fun writeWaveHeader(file: RandomAccessFile, dataBytes: Long) {
            if (dataBytes > Int.MAX_VALUE) throw AudioCaptureFailure("Audio capture is too large")
            file.seek(0)
            file.writeBytes("RIFF")
            file.writeLittleEndianInt((36 + dataBytes).toInt())
            file.writeBytes("WAVE")
            file.writeBytes("fmt ")
            file.writeLittleEndianInt(16)
            file.writeLittleEndianShort(1)
            file.writeLittleEndianShort(1)
            file.writeLittleEndianInt(SAMPLE_RATE_HZ)
            file.writeLittleEndianInt(SAMPLE_RATE_HZ * 2)
            file.writeLittleEndianShort(2)
            file.writeLittleEndianShort(16)
            file.writeBytes("data")
            file.writeLittleEndianInt(dataBytes.toInt())
        }

        private fun RandomAccessFile.writeLittleEndianInt(value: Int) {
            write(value and 0xff)
            write((value ushr 8) and 0xff)
            write((value ushr 16) and 0xff)
            write((value ushr 24) and 0xff)
        }

        private fun RandomAccessFile.writeLittleEndianShort(value: Int) {
            write(value and 0xff)
            write((value ushr 8) and 0xff)
        }
    }
}

internal fun normalizeVoiceLevel(rms: Double): Float =
    ((rms - 0.008) / 0.14).coerceIn(0.0, 1.0).toFloat()
