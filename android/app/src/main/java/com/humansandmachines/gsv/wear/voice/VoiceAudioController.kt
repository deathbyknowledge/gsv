package com.humansandmachines.gsv.wear.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.ToneGenerator
import android.os.Build
import java.io.Closeable
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class VoiceAudioController(private val context: Context) : Closeable {
    private val audioManager = context.getSystemService(AudioManager::class.java)

    @Volatile
    private var activePlayer: MediaPlayer? = null

    suspend fun <T> capture(block: suspend () -> T): T = withAudioFocus(
        gain = AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
        usage = AudioAttributes.USAGE_VOICE_COMMUNICATION,
    ) {
        val priorMode = audioManager.mode
        var communicationSelected = false
        try {
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            communicationSelected = selectHeadsetCommunicationDevice()
            if (communicationSelected) delay(250)
            playTone(ToneGenerator.TONE_PROP_BEEP, 120)
            delay(80)
            block()
        } finally {
            if (communicationSelected && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice()
            }
            audioManager.mode = priorMode
        }
    }

    suspend fun play(speech: SynthesizedVoice) {
        val file = withContext(Dispatchers.IO) {
            File.createTempFile("gsv-voice-reply-", extensionFor(speech.mimeType), context.cacheDir).also {
                it.writeBytes(speech.bytes)
            }
        }
        try {
            withAudioFocus(
                gain = AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
                usage = AudioAttributes.USAGE_ASSISTANT,
            ) {
                playFile(file)
            }
        } finally {
            file.delete()
        }
    }

    suspend fun <T> withLocalSpeech(block: suspend () -> T): T = withAudioFocus(
        gain = AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
        usage = AudioAttributes.USAGE_ASSISTANT,
        block = block,
    )

    fun stopPlayback() {
        activePlayer?.let { player ->
            runCatching { player.stop() }
            player.release()
        }
        activePlayer = null
    }

    override fun close() {
        stopPlayback()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            runCatching { audioManager.clearCommunicationDevice() }
        }
    }

    private suspend fun <T> withAudioFocus(
        gain: Int,
        usage: Int,
        block: suspend () -> T,
    ): T {
        val request = AudioFocusRequest.Builder(gain)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(usage)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAcceptsDelayedFocusGain(false)
            .setOnAudioFocusChangeListener { change ->
                if (change == AudioManager.AUDIOFOCUS_LOSS) stopPlayback()
            }
            .build()
        if (audioManager.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            throw VoiceClientFailure("Audio is currently unavailable")
        }
        try {
            return block()
        } finally {
            audioManager.abandonAudioFocusRequest(request)
        }
    }

    private fun selectHeadsetCommunicationDevice(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
        val preferredTypes = listOf(
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_USB_HEADSET,
        )
        val devices = runCatching { audioManager.availableCommunicationDevices }.getOrDefault(emptyList())
        val device = preferredTypes.firstNotNullOfOrNull { type -> devices.firstOrNull { it.type == type } }
            ?: return false
        return runCatching { audioManager.setCommunicationDevice(device) }.getOrDefault(false)
    }

    private suspend fun playTone(tone: Int, durationMillis: Int) {
        val generator = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 70)
        try {
            generator.startTone(tone, durationMillis)
            delay(durationMillis.toLong())
        } finally {
            generator.release()
        }
    }

    private suspend fun playFile(file: File) = suspendCancellableCoroutine { continuation ->
        val released = AtomicBoolean(false)
        val player = MediaPlayer()
        fun release() {
            if (released.compareAndSet(false, true)) {
                if (activePlayer === player) activePlayer = null
                player.release()
            }
        }
        activePlayer = player
        player.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        player.setOnPreparedListener { it.start() }
        player.setOnCompletionListener {
            release()
            if (continuation.isActive) continuation.resume(Unit)
        }
        player.setOnErrorListener { _, _, _ ->
            release()
            if (continuation.isActive) {
                continuation.resumeWithException(VoiceClientFailure("Speech playback failed"))
            }
            true
        }
        continuation.invokeOnCancellation {
            runCatching { player.stop() }
            release()
        }
        try {
            player.setDataSource(file.absolutePath)
            player.prepareAsync()
        } catch (_: Exception) {
            release()
            if (continuation.isActive) {
                continuation.resumeWithException(VoiceClientFailure("Speech playback could not start"))
            }
        }
    }

    private fun extensionFor(mimeType: String): String = when (mimeType.lowercase()) {
        "audio/mpeg" -> ".mp3"
        "audio/aac" -> ".aac"
        "audio/ogg", "audio/opus" -> ".ogg"
        "audio/wav", "audio/x-wav" -> ".wav"
        else -> ".audio"
    }
}
