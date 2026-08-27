package com.humansandmachines.gsv.wear.voice

import com.humansandmachines.gsv.wear.actions.AndroidActions
import com.humansandmachines.gsv.wear.audio.AssistantMicrophone
import java.io.Closeable
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class VoiceTurnCoordinator(
    private val microphone: AssistantMicrophone,
    private val actions: AndroidActions,
    private val audio: VoiceAudioController,
    private val client: () -> VoiceClientSupervisor?,
    private val publishState: (VoiceTurnState) -> Unit = {},
    private val publishLevel: (Float) -> Unit = {},
) : VoiceTurnOwner, Closeable {
    private val turnGeneration = AtomicLong(0)
    private val listeningGeneration = AtomicLong(0)
    private val finishRequestedGeneration = AtomicLong(0)

    override fun finishListening(): Boolean {
        val generation = listeningGeneration.get()
        if (generation == 0L) return false
        finishRequestedGeneration.set(generation)
        return true
    }

    override suspend fun runVoiceTurn(
        captureRoute: VoiceCaptureRoute?,
        onState: (VoiceTurnState) -> Unit,
    ) {
        val generation = turnGeneration.incrementAndGet()
        val report: (VoiceTurnState) -> Unit = { state ->
            if (turnGeneration.get() == generation) {
                publishState(state)
                onState(state)
            }
        }
        val reportLevel: (Float) -> Unit = { level ->
            if (turnGeneration.get() == generation) publishLevel(level)
        }
        try {
            report(VoiceTurnState.PREPARING)
            val session = try {
                client()?.awaitSession()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                null
            } ?: return speakLocal("GSV is offline.", report, reportLevel)

            listeningGeneration.set(generation)
            report(VoiceTurnState.LISTENING)
            val captured = try {
                audio.capture {
                    microphone.listenUntilSpeech(
                        timeoutMillis = MAX_LISTEN_MILLIS,
                        trailingMillis = END_OF_SPEECH_MILLIS,
                        preferredDevice = captureRoute?.preferredInputDevice,
                        onLevel = reportLevel,
                        stopRequested = { finishRequestedGeneration.get() == generation },
                    )
                }
            } finally {
                listeningGeneration.compareAndSet(generation, 0)
                finishRequestedGeneration.compareAndSet(generation, 0)
                captureRoute?.close()
            }
            report(VoiceTurnState.THINKING)
            val bytes = try {
                withContext(Dispatchers.IO) { captured.file.readBytes() }
            } finally {
                captured.close()
            }

            val transcript = session.transcribe(bytes, "wear-voice.wav")
            val runId = session.sendToShip(transcript)
            val spokenText = when (val terminal = session.awaitRun(runId)) {
                VoiceRunTerminal.ApprovalRequired ->
                    "I need your approval. Open GSV on a screen to review it."
                is VoiceRunTerminal.Answer -> terminal.text
                is VoiceRunTerminal.Finished -> terminalText(terminal)
            }
            speakResponse(session, spokenText, report, reportLevel)
            report(VoiceTurnState.IDLE)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            speakLocal("That voice request failed. Please try again.", report, reportLevel)
        } finally {
            listeningGeneration.compareAndSet(generation, 0)
            finishRequestedGeneration.compareAndSet(generation, 0)
            if (turnGeneration.compareAndSet(generation, generation + 1)) {
                publishLevel(0f)
                publishState(VoiceTurnState.IDLE)
            }
        }
    }

    override fun close() {
        turnGeneration.incrementAndGet()
        listeningGeneration.set(0)
        finishRequestedGeneration.set(0)
        publishLevel(0f)
        audio.close()
    }

    private suspend fun speakResponse(
        session: VoiceClientSession,
        text: String,
        onState: (VoiceTurnState) -> Unit,
        onLevel: (Float) -> Unit,
    ) {
        val bounded = boundSpeech(text)
        onState(VoiceTurnState.SPEAKING)
        try {
            audio.speakLocal(plainForLocalSpeech(bounded), onLevel)
            return
        } catch (error: CancellationException) {
            throw error
        } catch (error: EmbeddedSpeechFailure) {
            if (error.playbackStarted) return
        } catch (_: Exception) {
            // A gateway voice remains available when the local engine cannot start.
        }
        val gatewaySpeech = if (session.supports("ai.speech.create")) {
            try {
                session.synthesize(bounded)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                null
            }
        } else {
            null
        }
        if (gatewaySpeech != null) {
            try {
                audio.play(gatewaySpeech)
                return
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // The generic Android action is the final fallback for a failed media response.
            }
        }
        audio.withLocalSpeech {
            actions.speak(plainForLocalSpeech(bounded), null, 1.0f, 1.0f)
        }
    }

    private suspend fun speakLocal(
        text: String,
        onState: (VoiceTurnState) -> Unit,
        onLevel: (Float) -> Unit,
    ) {
        onState(VoiceTurnState.ERROR)
        try {
            try {
                audio.speakLocal(text, onLevel)
            } catch (error: CancellationException) {
                throw error
            } catch (error: EmbeddedSpeechFailure) {
                if (!error.playbackStarted) {
                    audio.withLocalSpeech { actions.speak(text, null, 1.0f, 1.0f) }
                }
            } catch (_: Exception) {
                audio.withLocalSpeech { actions.speak(text, null, 1.0f, 1.0f) }
            }
        } catch (error: CancellationException) {
            onLevel(0f)
            throw error
        } catch (_: Exception) {
            // There is no remaining speech path for an offline/error announcement.
        }
        onLevel(0f)
        onState(VoiceTurnState.IDLE)
    }

    private fun terminalText(terminal: VoiceRunTerminal.Finished): String {
        val payload = terminal.payload
        return when (payload.optString("status")) {
            "aborted" -> "That request was stopped."
            "ok" -> "Done."
            else -> "The agent could not finish that request."
        }
    }

    private fun boundSpeech(text: String): String {
        val trimmed = text.trim().ifBlank { "Done." }
        if (trimmed.length <= MAX_SPEECH_CHARS) return trimmed
        return trimmed.take(MAX_SPEECH_CHARS).trimEnd() +
            ". I left the complete response in GSV."
    }

    private fun plainForLocalSpeech(text: String): String = text
        .replace(Regex("```[\\s\\S]*?```"), " code block ")
        .replace(Regex("`([^`]*)`"), "\$1")
        .replace(Regex("\\[([^]]+)]\\([^)]+\\)"), "\$1")
        .replace(Regex("[*_#>]"), "")
        .replace(Regex("\\s+"), " ")
        .trim()

    companion object {
        private const val MAX_LISTEN_MILLIS = 25_000L
        private const val END_OF_SPEECH_MILLIS = 900L
        private const val MAX_SPEECH_CHARS = 3_500
    }
}
