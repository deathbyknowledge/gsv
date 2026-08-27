package com.humansandmachines.gsv.wear.audio

import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test

class MicrophoneCaptureArbiterTest {
    @Test
    fun assistantCapturePreemptsDriverCapture() = runBlocking {
        val driverStarted = CompletableDeferred<Unit>()
        val driverCancelled = AtomicBoolean(false)
        val driver = launch {
            try {
                MicrophoneCaptureArbiter.capture(MicrophoneCapturePriority.DRIVER) {
                    driverStarted.complete(Unit)
                    awaitCancellation()
                }
            } finally {
                driverCancelled.set(true)
            }
        }

        driverStarted.await()
        var assistantRan = false
        MicrophoneCaptureArbiter.capture(MicrophoneCapturePriority.ASSISTANT) {
            assistantRan = true
        }
        driver.join()

        assertTrue(driverCancelled.get())
        assertTrue(assistantRan)
    }
}
