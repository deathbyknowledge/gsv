package com.humansandmachines.gsv.wear.gesture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeGestureResultTest {
    @Test
    fun decodesBoundedSemanticStatus() {
        val packed = 3L or (731L shl 8) or (2L shl 18) or (37L shl 20)
        val result = NativeGestureResult.decode(packed)

        assertFalse(result.failed)
        assertEquals(NativeGestureEvent.SEND, result.event)
        assertEquals(0.731f, result.progress)
        assertEquals(2, result.handCount)
        assertEquals(37, result.inferenceMillis)
    }

    @Test
    fun treatsNativeErrorFramesAsNonActionable() {
        val result = NativeGestureResult.decode(Long.MIN_VALUE or 4)

        assertTrue(result.failed)
        assertEquals(NativeGestureEvent.NONE, result.event)
    }
}
