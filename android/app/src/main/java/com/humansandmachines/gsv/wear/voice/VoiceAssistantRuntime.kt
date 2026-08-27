package com.humansandmachines.gsv.wear.voice

import android.media.AudioDeviceInfo
import java.io.Closeable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

enum class VoiceTurnState {
    IDLE,
    PREPARING,
    LISTENING,
    THINKING,
    SPEAKING,
    ERROR,
}

fun interface VoiceTurnOwner {
    suspend fun runVoiceTurn(captureRoute: VoiceCaptureRoute?, onState: (VoiceTurnState) -> Unit)
}

interface VoiceCaptureRoute : Closeable {
    val preferredInputDevice: AudioDeviceInfo?
}

object VoiceAssistantRuntime {
    private var owner: VoiceTurnOwner? = null
    private var activeJob: Job? = null
    private var generation = 0L

    @Synchronized
    fun attach(candidate: VoiceTurnOwner) {
        owner = candidate
    }

    @Synchronized
    fun detach(candidate: VoiceTurnOwner) {
        if (owner === candidate) {
            owner = null
            activeJob?.cancel()
            activeJob = null
            generation += 1
        }
    }

    fun startTurn(
        scope: CoroutineScope,
        onState: (VoiceTurnState) -> Unit = {},
        onFinished: () -> Unit = {},
        captureRoute: VoiceCaptureRoute? = null,
    ): Job {
        val selectedOwner: VoiceTurnOwner?
        val selectedGeneration: Long
        synchronized(this) {
            activeJob?.cancel()
            generation += 1
            selectedGeneration = generation
            selectedOwner = owner
        }
        val job = scope.launch {
            try {
                if (selectedOwner == null) {
                    onState(VoiceTurnState.ERROR)
                } else {
                    selectedOwner.runVoiceTurn(captureRoute, onState)
                }
            } finally {
                captureRoute?.close()
                val current = synchronized(this@VoiceAssistantRuntime) {
                    generation == selectedGeneration
                }
                if (current) onFinished()
            }
        }
        synchronized(this) {
            if (generation == selectedGeneration) activeJob = job
        }
        return job
    }
}
