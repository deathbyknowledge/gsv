package com.humansandmachines.gsv.wear.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class AssistantActivityVisualTest {
    @Test
    fun crossActivityEnergyBlendsWithoutFallingBackToTheBaseState() {
        val phase = 1.7f
        val reading = AssistantActivityParameters(reading = 1f).energy(phase)
        val searching = AssistantActivityParameters(searching = 1f).energy(phase)
        val midpoint = AssistantActivityParameters(reading = 0.5f, searching = 0.5f)

        assertEquals(1f, midpoint.presence, 0.0001f)
        assertEquals((reading + searching) / 2f, midpoint.energy(phase), 0.0001f)
    }

    @Test
    fun releasePresenceTracksTheRemainingActivityWeight() {
        assertEquals(
            0.35f,
            AssistantActivityParameters(executing = 0.35f).presence,
            0.0001f,
        )
    }
}
