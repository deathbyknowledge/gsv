package com.humansandmachines.gsv.wear.connection

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionEpochTest {
    @Test
    fun staleCallbacksCannotMatchANewerConnection() {
        val epochs = ConnectionEpoch()
        val first = epochs.next()
        val second = epochs.next()

        assertFalse(epochs.isCurrent(first))
        assertTrue(epochs.isCurrent(second))
        epochs.invalidate()
        assertFalse(epochs.isCurrent(second))
    }
}
