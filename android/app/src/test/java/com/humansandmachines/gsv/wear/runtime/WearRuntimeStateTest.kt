package com.humansandmachines.gsv.wear.runtime

import com.humansandmachines.gsv.wear.voice.AssistantRuntimeState
import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class WearRuntimeStateTest {
    @After
    fun tearDown() {
        WearRuntimeState.reset()
        AssistantRuntimeState.reset()
    }

    @Test
    fun resettingWearDoesNotResetMind() {
        AssistantRuntimeState.setTurn(VoiceTurnState.LISTENING)

        WearRuntimeState.reset()

        assertEquals(VoiceTurnState.LISTENING, AssistantRuntimeState.snapshot.value.turn)
    }
}
