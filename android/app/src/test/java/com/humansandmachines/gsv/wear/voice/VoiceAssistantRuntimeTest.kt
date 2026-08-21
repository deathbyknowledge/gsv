package com.humansandmachines.gsv.wear.voice

import android.media.AudioDeviceInfo
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceAssistantRuntimeTest {
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

    private class FakeCaptureRoute : VoiceCaptureRoute {
        val closed = AtomicBoolean(false)

        override val preferredInputDevice: AudioDeviceInfo? = null

        override fun close() {
            closed.set(true)
        }
    }
}
