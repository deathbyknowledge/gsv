package com.humansandmachines.gsv.wear.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class GestureFeedbackTest {
    @Test
    fun sparseRecognitionSamplesProjectIntoContinuousVisualEvidence() {
        assertEquals(0f, projectedGestureEvidence(0f), 0.001f)
        assertEquals(0.58f, projectedGestureEvidence(0.34f), 0.001f)
        assertEquals(0.93f, projectedGestureEvidence(0.69f), 0.001f)
        assertEquals(0.94f, projectedGestureEvidence(1f), 0.001f)
    }
}
