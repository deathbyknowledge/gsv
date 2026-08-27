package com.humansandmachines.gsv.wear.ui

import android.content.Context
import com.humansandmachines.gsv.wear.voice.VoiceAudioController
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive

internal class DebugSpeechSamplePlayer(context: Context) : Closeable {
    private val audio = VoiceAudioController(context)
    private val closed = AtomicBoolean(false)

    suspend fun playLoop(onLevel: (Float) -> Unit) {
        while (!closed.get()) {
            currentCoroutineContext().ensureActive()
            audio.speakLocal(REVIEW_PHRASE, onLevel)
            if (!closed.get()) delay(LOOP_PAUSE_MILLIS)
        }
    }

    override fun close() {
        closed.set(true)
        audio.close()
    }

    private companion object {
        const val REVIEW_PHRASE =
            "The signal is clear. Your assistant is connected and ready to respond."
        const val LOOP_PAUSE_MILLIS = 720L
    }
}
