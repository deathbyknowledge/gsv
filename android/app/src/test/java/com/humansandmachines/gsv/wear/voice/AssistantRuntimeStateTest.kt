package com.humansandmachines.gsv.wear.voice

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class AssistantRuntimeStateTest {
    @After
    fun resetState() {
        AssistantRuntimeState.reset()
    }

    @Test
    fun levelExistsOnlyWhileAudioIsReactive() {
        AssistantRuntimeState.setLevel(0.7f)
        assertEquals(0f, AssistantRuntimeState.snapshot.value.level)

        AssistantRuntimeState.setTurn(VoiceTurnState.LISTENING)
        AssistantRuntimeState.setLevel(1.4f)
        assertEquals(1f, AssistantRuntimeState.snapshot.value.level)

        AssistantRuntimeState.setTurn(VoiceTurnState.THINKING)
        assertEquals(0f, AssistantRuntimeState.snapshot.value.level)

        AssistantRuntimeState.setLevel(0.4f)
        assertEquals(0f, AssistantRuntimeState.snapshot.value.level)

        AssistantRuntimeState.setTurn(VoiceTurnState.SPEAKING)
        AssistantRuntimeState.setLevel(0.65f)
        assertEquals(0.65f, AssistantRuntimeState.snapshot.value.level)

        AssistantRuntimeState.setTurn(VoiceTurnState.IDLE)
        assertEquals(0f, AssistantRuntimeState.snapshot.value.level)
    }
}
