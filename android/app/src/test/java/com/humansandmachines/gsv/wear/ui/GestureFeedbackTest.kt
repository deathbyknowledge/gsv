package com.humansandmachines.gsv.wear.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class GestureFeedbackTest {
    @Test
    fun sparseRecognitionSamplesKeepAdvancingTowardConfirmation() {
        assertEquals(350, gestureEvidenceAdvanceDurationMillis(0f))
        assertEquals(231, gestureEvidenceAdvanceDurationMillis(0.34f))
        assertEquals(140, gestureEvidenceAdvanceDurationMillis(0.69f))
        assertEquals(140, gestureEvidenceAdvanceDurationMillis(1f))
    }
}
