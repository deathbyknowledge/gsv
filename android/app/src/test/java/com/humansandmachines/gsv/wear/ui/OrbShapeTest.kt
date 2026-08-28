package com.humansandmachines.gsv.wear.ui

import com.humansandmachines.gsv.wear.authority.AuthorityState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    @Test
    fun shipMaterializationFollowsRuntimeAuthority() {
        assertEquals(
            ShipRenderMode.HOLOGRAM,
            shipRenderModeFor(AuthorityState.DISARMED),
        )
        assertEquals(
            ShipRenderMode.PHYSICAL,
            shipRenderModeFor(AuthorityState.ARMED),
        )
        assertEquals(
            ShipRenderMode.PHYSICAL,
            shipRenderModeFor(AuthorityState.PAUSED),
        )
    }

    @Test
    fun shipPropulsionRunsOnlyWhileWearAuthorityIsArmed() {
        assertFalse(shipPropulsionActiveFor(AuthorityState.DISARMED))
        assertTrue(shipPropulsionActiveFor(AuthorityState.ARMED))
        assertFalse(shipPropulsionActiveFor(AuthorityState.PAUSED))
    }
}
