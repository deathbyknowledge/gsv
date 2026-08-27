package com.humansandmachines.gsv.wear.camera

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraSessionArbiterTest {
    @Test
    fun pausesAndRestoresTheVisibleSessionAroundDriverUse() = runBlocking {
        val events = mutableListOf<String>()
        val session = object : ForegroundCameraSession {
            override suspend fun pauseForExclusiveUse() {
                events += "pause"
            }

            override suspend fun resumeAfterExclusiveUse() {
                events += "resume"
            }
        }
        assertTrue(CameraSessionArbiter.register(session))
        try {
            val result = CameraSessionArbiter.withExclusiveCamera {
                events += "capture"
                42
            }
            assertEquals(42, result)
            assertEquals(listOf("pause", "capture", "resume"), events)
        } finally {
            CameraSessionArbiter.unregister(session)
        }
    }
}
