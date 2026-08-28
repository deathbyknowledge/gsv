package com.humansandmachines.gsv.wear.ui

import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import org.junit.Assert.assertEquals
import org.junit.Test

class AssistantFrameCadenceTest {
    @Test
    fun limitsAmbientAndShipAnimationToThirtyFramesPerSecond() {
        assertEquals(
            33_333_333L,
            assistantFrameIntervalNanos(
                VoiceTurnState.IDLE,
                OrbShapeTarget.LISTENING,
            ),
        )
        assertEquals(
            33_333_333L,
            assistantFrameIntervalNanos(
                VoiceTurnState.LISTENING,
                OrbShapeTarget.SHIP,
            ),
        )
    }

    @Test
    fun keepsActiveMindAnimationAtSixtyFramesPerSecond() {
        assertEquals(
            16_666_667L,
            assistantFrameIntervalNanos(
                VoiceTurnState.SPEAKING,
                OrbShapeTarget.LISTENING,
            ),
        )
    }
}
