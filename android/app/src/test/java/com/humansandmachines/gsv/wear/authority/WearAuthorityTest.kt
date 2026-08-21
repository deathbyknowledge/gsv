package com.humansandmachines.gsv.wear.authority

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WearAuthorityTest {
    @Test
    fun onlyArmedAuthorityIssuesAUsableLease() {
        val authority = WearAuthority { "generation-1" }
        assertNull(authority.acquire())

        val armed = authority.arm()
        assertTrue(authority.isCurrent(armed))

        assertTrue(authority.pause())
        assertNull(authority.acquire())
        assertFalse(authority.isCurrent(armed))

        assertTrue(authority.resume())
        assertTrue(authority.isCurrent(armed))
    }

    @Test
    fun disarmIrrevocablyInvalidatesPriorLeases() {
        var generation = 0
        val authority = WearAuthority { "generation-${++generation}" }
        val first = authority.arm()
        authority.disarm()

        assertEquals(AuthorityState.DISARMED, authority.state())
        assertFalse(authority.resume())
        assertFalse(authority.isCurrent(first))

        val second = authority.arm()
        assertFalse(authority.isCurrent(first))
        assertTrue(authority.isCurrent(second))
    }

    @Test
    fun leasesNeverRenderTheirGeneration() {
        val lease = WearAuthority { "private-generation" }.arm()

        assertFalse(lease.toString().contains("private-generation"))
    }
}
