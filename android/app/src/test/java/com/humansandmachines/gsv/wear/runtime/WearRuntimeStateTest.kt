package com.humansandmachines.gsv.wear.runtime

import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class WearRuntimeStateTest {
    @After
    fun tearDown() {
        WearRuntimeState.reset()
    }

    @Test
    fun voiceLevelExistsOnlyWhileListening() {
        WearRuntimeState.setVoiceLevel(0.7f)
        assertEquals(0f, WearRuntimeState.snapshot.value.voiceLevel)

        WearRuntimeState.setVoiceTurn(VoiceTurnState.LISTENING)
        WearRuntimeState.setVoiceLevel(1.4f)
        assertEquals(1f, WearRuntimeState.snapshot.value.voiceLevel)

        WearRuntimeState.setVoiceTurn(VoiceTurnState.THINKING)
        assertEquals(0f, WearRuntimeState.snapshot.value.voiceLevel)
    }
}
