package com.humansandmachines.gsv.wear.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class OrbShapeTest {
    @Test
    fun shipTargetKeepsTheLiquidAndExcludesTheSmileCutout() {
        val parameters = OrbShapeTarget.SHIP.parameters

        assertEquals(1f, parameters.organicAmount)
        assertEquals(0f, parameters.symbolPresence)
        assertEquals(1f, parameters.shipPresence)
    }

    @Test
    fun productionListeningTargetDoesNotSelectTheShip() {
        assertEquals(0f, OrbShapeTarget.LISTENING.parameters.shipPresence)
    }
}
