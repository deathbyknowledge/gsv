package com.humansandmachines.gsv.wear.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReconnectPolicyTest {
    @Test
    fun exponentiallyCapsRetryWindows() {
        val ceilings = mutableListOf<Long>()
        val policy = ReconnectPolicy(
            initialDelayMillis = 1_000,
            maximumDelayMillis = 4_000,
            jitter = JitterSource { ceiling ->
                ceilings += ceiling
                ceiling - 1
            },
        )

        assertEquals(listOf(1_000L, 2_000L, 4_000L, 4_000L), List(4) { policy.nextDelayMillis() })
        assertEquals(listOf(1_001L, 2_001L, 4_001L, 4_001L), ceilings)
    }

    @Test
    fun resetReturnsToTheInitialWindow() {
        val policy = ReconnectPolicy(jitter = JitterSource { it - 1 })
        policy.nextDelayMillis()
        policy.nextDelayMillis()
        policy.reset()

        assertTrue(policy.nextDelayMillis() <= 1_000L)
    }
}
