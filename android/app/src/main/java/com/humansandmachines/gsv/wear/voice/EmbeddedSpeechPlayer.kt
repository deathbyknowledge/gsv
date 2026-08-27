@file:Suppress("OVERRIDE_DEPRECATION")

package com.humansandmachines.gsv.wear.voice

import android.content.Context
import android.media.AudioAttributes
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.io.Closeable
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

internal class EmbeddedSpeechFailure(
    message: String,
    val playbackStarted: Boolean,
    cause: Throwable? = null,
) : Exception(message, cause)

internal class EmbeddedSpeechPlayer(context: Context) : Closeable {
    private val applicationContext = context.applicationContext
    private val speechMutex = Mutex()
    private val closed = AtomicBoolean(false)
    private val activeLock = Any()

    @Volatile
    private var engine: TextToSpeech? = null

    @Volatile
    private var initializingEngine: TextToSpeech? = null

    private var activeAbort: ((Throwable) -> Unit)? = null
    private var activePlaybackStarted: AtomicBoolean? = null

    suspend fun speak(
        text: String,
        rate: Float = 1f,
        pitch: Float = 1f,
        onLevel: (Float) -> Unit = {},
    ) = speechMutex.withLock {
        if (text.isBlank()) throw EmbeddedSpeechFailure("Speech text is empty", false)
        if (text.length > TextToSpeech.getMaxSpeechInputLength()) {
            throw EmbeddedSpeechFailure("Speech text is too long", false)
        }
        if (closed.get()) throw CancellationException("Embedded speech player is closed")

        val selectedEngine = getOrCreateEngine()
        prepareLocalVoice(selectedEngine, rate, pitch)
        val playbackStarted = AtomicBoolean(false)
        try {
            withTimeout(MAX_SPEECH_MILLIS) {
                selectedEngine.awaitSpeech(text, playbackStarted, onLevel)
            }
        } catch (error: TimeoutCancellationException) {
            currentCoroutineContext().ensureActive()
            throw EmbeddedSpeechFailure(
                message = "Embedded speech timed out",
                playbackStarted = playbackStarted.get(),
                cause = error,
            )
        }
    }

    fun stop() {
        val active = synchronized(activeLock) { activeAbort to activePlaybackStarted }
        active.first?.invoke(
            EmbeddedSpeechFailure(
                "Embedded speech stopped",
                active.second?.get() == true,
            ),
        )
        runCatching { engine?.stop() }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val abort = synchronized(activeLock) { activeAbort }
        abort?.invoke(CancellationException("Embedded speech player closed"))
        val active = engine
        engine = null
        val initializing = initializingEngine
        initializingEngine = null
        runCatching { active?.stop() }
        runCatching { active?.shutdown() }
        if (initializing !== active) runCatching { initializing?.shutdown() }
    }

    private suspend fun getOrCreateEngine(): TextToSpeech {
        engine?.let { return it }
        val created = try {
            withTimeout(INITIALIZATION_TIMEOUT_MILLIS) { createEngine() }
        } catch (error: TimeoutCancellationException) {
            currentCoroutineContext().ensureActive()
            throw EmbeddedSpeechFailure("Embedded speech initialization timed out", false, error)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            throw EmbeddedSpeechFailure("Embedded speech is unavailable", false, error)
        }
        if (closed.get()) {
            created.shutdown()
            throw CancellationException("Embedded speech player is closed")
        }
        engine = created
        return created
    }

    private suspend fun createEngine(): TextToSpeech = withContext(Dispatchers.Main.immediate) {
        suspendCancellableCoroutine { continuation ->
            lateinit var candidate: TextToSpeech
            candidate = TextToSpeech(applicationContext) { status ->
                if (initializingEngine === candidate) initializingEngine = null
                if (!continuation.isActive || closed.get()) {
                    candidate.shutdown()
                } else if (status == TextToSpeech.SUCCESS) {
                    continuation.resume(candidate)
                } else {
                    candidate.shutdown()
                    continuation.resumeWithException(
                        EmbeddedSpeechFailure("Embedded speech initialization failed", false),
                    )
                }
            }
            initializingEngine = candidate
            continuation.invokeOnCancellation {
                if (initializingEngine === candidate) initializingEngine = null
                runCatching { candidate.shutdown() }
            }
        }
    }

    private fun prepareLocalVoice(selectedEngine: TextToSpeech, rate: Float, pitch: Float) {
        val voice = selectLocalVoice(selectedEngine, Locale.getDefault())
            ?: throw EmbeddedSpeechFailure("No installed voice is available for this language", false)
        if (selectedEngine.setVoice(voice) != TextToSpeech.SUCCESS) {
            throw EmbeddedSpeechFailure("The installed voice could not be selected", false)
        }
        if (
            selectedEngine.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            ) != TextToSpeech.SUCCESS
        ) {
            throw EmbeddedSpeechFailure("Assistant audio could not be configured", false)
        }
        if (
            selectedEngine.setSpeechRate(rate) != TextToSpeech.SUCCESS ||
            selectedEngine.setPitch(pitch) != TextToSpeech.SUCCESS
        ) {
            throw EmbeddedSpeechFailure("Embedded speech voice settings were rejected", false)
        }
    }

    private fun selectLocalVoice(selectedEngine: TextToSpeech, locale: Locale): Voice? {
        val current = runCatching { selectedEngine.voice }.getOrNull()
        val available = runCatching { selectedEngine.voices.orEmpty() }.getOrDefault(emptySet())
        return sequenceOf(current)
            .plus(available.asSequence())
            .filterNotNull()
            .distinctBy(Voice::getName)
            .filter { voice ->
                !voice.isNetworkConnectionRequired &&
                    voice.locale.language.equals(locale.language, ignoreCase = true)
            }
            .maxWithOrNull(
                compareBy<Voice> { voice -> localeAffinity(voice.locale, locale) }
                    .thenBy(Voice::getQuality)
                    .thenByDescending(Voice::getLatency),
            )
    }

    private suspend fun TextToSpeech.awaitSpeech(
        text: String,
        playbackStarted: AtomicBoolean,
        onLevel: (Float) -> Unit,
    ) = coroutineScope {
        val start = CompletableDeferred<Unit>()
        val levels = Channel<Float>(Channel.UNLIMITED)
        val levelEmitter = launch(Dispatchers.Default) {
            start.await()
            for (level in levels) {
                runCatching { onLevel(level) }
                delay(SPEECH_LEVEL_INTERVAL_MILLIS)
            }
        }
        try {
            suspendCancellableCoroutine { continuation ->
                val utteranceId = UUID.randomUUID().toString()
                val completed = AtomicBoolean(false)
                val meterLock = Any()
                var meter: PcmLevelAccumulator? = null
                lateinit var abort: (Throwable) -> Unit

                fun clearActive() {
                    synchronized(activeLock) {
                        if (activeAbort === abort) {
                            activeAbort = null
                            activePlaybackStarted = null
                        }
                    }
                }

                fun completeNormally() {
                    if (!completed.compareAndSet(false, true)) return
                    val finalLevel = synchronized(meterLock) { meter?.finish() }
                    if (finalLevel != null) levels.trySend(finalLevel)
                    levels.close()
                    clearActive()
                    if (continuation.isActive) continuation.resume(Unit)
                }

                abort = { error ->
                    if (completed.compareAndSet(false, true)) {
                        levels.close()
                        clearActive()
                        runCatching { stop() }
                        if (continuation.isActive) continuation.resumeWithException(error)
                    }
                }
                synchronized(activeLock) {
                    activeAbort = abort
                    activePlaybackStarted = playbackStarted
                }

                val listenerResult = setOnUtteranceProgressListener(
                    object : UtteranceProgressListener() {
                        override fun onStart(id: String) {
                            if (id != utteranceId) return
                            playbackStarted.set(true)
                            start.complete(Unit)
                        }

                        override fun onBeginSynthesis(
                            id: String,
                            sampleRateInHz: Int,
                            audioFormat: Int,
                            channelCount: Int,
                        ) {
                            if (id != utteranceId) return
                            val created = PcmLevelAccumulator.create(
                                sampleRate = sampleRateInHz,
                                encoding = audioFormat,
                                channelCount = channelCount,
                            )
                            if (created == null) {
                                abort(
                                    EmbeddedSpeechFailure(
                                        "Embedded speech returned unsupported audio",
                                        playbackStarted.get(),
                                    ),
                                )
                            } else {
                                synchronized(meterLock) { meter = created }
                            }
                        }

                        override fun onAudioAvailable(id: String, audio: ByteArray) {
                            if (id != utteranceId || completed.get()) return
                            val emitted = synchronized(meterLock) {
                                meter?.append(audio).orEmpty()
                            }
                            emitted.forEach { level -> levels.trySend(level) }
                        }

                        override fun onDone(id: String) {
                            if (id == utteranceId) completeNormally()
                        }

                        override fun onError(id: String) {
                            if (id == utteranceId) {
                                abort(
                                    EmbeddedSpeechFailure(
                                        "Embedded speech failed",
                                        playbackStarted.get(),
                                    ),
                                )
                            }
                        }

                        override fun onError(id: String, errorCode: Int) {
                            if (id == utteranceId) {
                                abort(
                                    EmbeddedSpeechFailure(
                                        "Embedded speech failed ($errorCode)",
                                        playbackStarted.get(),
                                    ),
                                )
                            }
                        }

                        override fun onStop(id: String, interrupted: Boolean) {
                            if (id == utteranceId) {
                                abort(
                                    EmbeddedSpeechFailure(
                                        "Embedded speech was stopped",
                                        playbackStarted.get(),
                                    ),
                                )
                            }
                        }
                    },
                )
                if (listenerResult != TextToSpeech.SUCCESS) {
                    abort(EmbeddedSpeechFailure("Speech callbacks are unavailable", false))
                    return@suspendCancellableCoroutine
                }
                if (closed.get()) {
                    abort(CancellationException("Embedded speech player is closed"))
                    return@suspendCancellableCoroutine
                }
                continuation.invokeOnCancellation {
                    if (completed.compareAndSet(false, true)) {
                        levels.close()
                        clearActive()
                        runCatching { stop() }
                    }
                }
                if (speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId) != TextToSpeech.SUCCESS) {
                    abort(EmbeddedSpeechFailure("Embedded speech request was rejected", false))
                }
            }
        } finally {
            levels.close()
            start.cancel()
            levelEmitter.cancelAndJoin()
            runCatching { onLevel(0f) }
        }
    }

    private fun localeAffinity(candidate: Locale, requested: Locale): Int = when {
        candidate.toLanguageTag().equals(requested.toLanguageTag(), ignoreCase = true) -> 3
        candidate.country.equals(requested.country, ignoreCase = true) -> 2
        else -> 1
    }

    private companion object {
        const val INITIALIZATION_TIMEOUT_MILLIS = 10_000L
        const val MAX_SPEECH_MILLIS = 120_000L
    }
}
