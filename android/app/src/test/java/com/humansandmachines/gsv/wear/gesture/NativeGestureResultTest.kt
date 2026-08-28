package com.humansandmachines.gsv.wear.gesture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeGestureResultTest {
    @Test
    fun decodesBoundedSemanticStatus() {
        val packed = 3L or (5L shl 4) or (731L shl 8) or (2L shl 18) or (37L shl 20)
        val result = NativeGestureResult.decode(packed)

        assertFalse(result.failed)
        assertEquals(NativeGestureEvent.SEND, result.event)
        assertEquals(NativeGestureChord.SEND, result.chord)
        assertEquals(0.731f, result.progress)
        assertEquals(2, result.handCount)
        assertEquals(37, result.inferenceMillis)
    }

    @Test
    fun treatsNativeErrorFramesAsNonActionable() {
        val result = NativeGestureResult.decode(Long.MIN_VALUE or 4)

        assertTrue(result.failed)
        assertEquals(NativeGestureEvent.NONE, result.event)
        assertEquals(NativeGestureChord.NONE, result.chord)
    }

    @Test
    fun exposesARecognizedCandidateBeforeProgressAdvances() {
        val result = NativeGestureResult.decode(3L shl 4)

        assertEquals(NativeGestureEvent.NONE, result.event)
        assertEquals(NativeGestureChord.START, result.chord)
        assertEquals(0f, result.progress)
    }

    @Test
    fun derivesOneContinuousTimelineFromInferenceCadence() {
        assertEquals(360, gestureCandidateFillDurationMillis(0L))
        assertEquals(416, gestureCandidateFillDurationMillis(104_000_000L))
        assertEquals(360, gestureCandidateFillDurationMillis(120_000_000L))
        assertEquals(450, gestureCandidateFillDurationMillis(150_000_000L))
    }
}
