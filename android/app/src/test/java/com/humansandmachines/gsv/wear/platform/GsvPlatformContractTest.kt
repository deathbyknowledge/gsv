package com.humansandmachines.gsv.wear.platform

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GsvPlatformContractTest {
    @Test
    fun acceptsOnlyImplementedApiVersions() {
        assertFalse(GsvPlatformContract.supportsApiVersion(0))
        assertTrue(GsvPlatformContract.supportsApiVersion(1))
        assertFalse(GsvPlatformContract.supportsApiVersion(2))
    }
}
