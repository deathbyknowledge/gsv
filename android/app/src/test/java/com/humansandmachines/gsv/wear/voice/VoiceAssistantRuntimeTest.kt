package com.humansandmachines.gsv.wear.voice

import android.media.AudioDeviceInfo
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

class VoiceAssistantRuntimeTest {
    @Test
    fun routesGracefulListeningCompletionOnlyToTheAttachedOwner() {
        val owner = object : VoiceTurnOwner {
            override suspend fun runVoiceTurn(
                captureRoute: VoiceCaptureRoute?,
                onState: (VoiceTurnState) -> Unit,
            ) = Unit

            override fun finishListening(): Boolean = true
        }
        assertFalse(VoiceAssistantRuntime.finishListeningAndSend())
        VoiceAssistantRuntime.attach(owner)
        try {
            assertTrue(VoiceAssistantRuntime.finishListeningAndSend())
        } finally {
            VoiceAssistantRuntime.detach(owner)
        }
        assertFalse(VoiceAssistantRuntime.finishListeningAndSend())
    }

    @Test
    fun closesTheCaptureRouteAfterTheTurn() = runBlocking {
        val route = FakeCaptureRoute()
        val owner = VoiceTurnOwner { captureRoute, onState ->
            onState(VoiceTurnState.LISTENING)
            captureRoute?.close()
        }
        VoiceAssistantRuntime.attach(owner)
        try {
            VoiceAssistantRuntime.startTurn(this, captureRoute = route).join()
            assertTrue(route.closed.get())
        } finally {
            VoiceAssistantRuntime.detach(owner)
        }
    }

    @Test
    fun closesTheCaptureRouteWhenNoRuntimeIsAttached() = runBlocking {
        val route = FakeCaptureRoute()

        VoiceAssistantRuntime.startTurn(this, captureRoute = route).join()

        assertTrue(route.closed.get())
    }

    @Test
    fun cancellingTheActiveTurnClosesItsCaptureRoute() = runBlocking {
        val route = FakeCaptureRoute()
        val started = CompletableDeferred<Unit>()
        val owner = VoiceTurnOwner { _, _ ->
            started.complete(Unit)
            awaitCancellation()
        }
        VoiceAssistantRuntime.attach(owner)
        try {
            val turn = VoiceAssistantRuntime.startTurn(this, captureRoute = route)
            started.await()

            VoiceAssistantRuntime.cancelActiveTurn()
            turn.join()

            assertTrue(route.closed.get())
        } finally {
            VoiceAssistantRuntime.detach(owner)
        }
    }

    private class FakeCaptureRoute : VoiceCaptureRoute {
        val closed = AtomicBoolean(false)

        override val preferredInputDevice: AudioDeviceInfo? = null

        override fun close() {
            closed.set(true)
        }
    }
}
