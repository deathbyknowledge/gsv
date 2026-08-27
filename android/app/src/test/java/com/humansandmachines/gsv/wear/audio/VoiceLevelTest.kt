package com.humansandmachines.gsv.wear.audio

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceLevelTest {
    @Test
    fun normalizesSilenceAndLoudSpeechIntoVisualRange() {
        assertEquals(0f, normalizeVoiceLevel(0.0))
        assertEquals(0f, normalizeVoiceLevel(0.008))
        assertEquals(0.3f, normalizeVoiceLevel(0.05), 0.001f)
        assertEquals(1f, normalizeVoiceLevel(0.148))
        assertEquals(1f, normalizeVoiceLevel(0.8))
    }
}
