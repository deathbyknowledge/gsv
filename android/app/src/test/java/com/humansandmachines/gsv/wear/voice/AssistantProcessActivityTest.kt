package com.humansandmachines.gsv.wear.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistantProcessActivityTest {
    @Test
    fun correlatesParallelToolsAndFallsBackToThePreviousVisibleActivity() {
        val ledger = AssistantProcessActivityLedger()

        assertEquals(
            AssistantProcessState(active = true, generation = 1L),
            ledger.apply(VoiceProcessEvent.RunStarted("run-1")),
        )
        assertEquals(
            AssistantActivity.READING,
            ledger.apply(toolStarted("run-1", "read-1", "call-read", AssistantActivity.READING))
                .activity,
        )
        assertEquals(
            AssistantActivity.SEARCHING,
            ledger.apply(toolStarted("run-1", "search-1", "call-search", AssistantActivity.SEARCHING))
                .activity,
        )

        val mismatchedFinish = ledger.apply(
            VoiceProcessEvent.ToolFinished("run-1", "search-1", "wrong-call"),
        )
        assertEquals(AssistantActivity.SEARCHING, mismatchedFinish.activity)

        val fallback = ledger.apply(
            VoiceProcessEvent.ToolFinished("run-1", "search-1", "call-search"),
        )
        assertEquals(AssistantActivity.READING, fallback.activity)

        val thinking = ledger.apply(
            VoiceProcessEvent.ToolFinished("run-1", "read-1", "call-read"),
        )
        assertTrue(thinking.active)
        assertEquals(AssistantActivity.NONE, thinking.activity)

        val finished = ledger.apply(VoiceProcessEvent.RunFinished("run-1"))
        assertFalse(finished.active)
    }

    @Test
    fun aNewRunRejectsLateEventsFromTheSupersededRun() {
        val ledger = AssistantProcessActivityLedger()
        ledger.apply(VoiceProcessEvent.RunStarted("run-old"))
        ledger.apply(toolStarted("run-old", "exec-old", "call-old", AssistantActivity.EXECUTING))
        val replacement = ledger.apply(VoiceProcessEvent.RunStarted("run-new"))
        ledger.apply(toolStarted("run-new", "write-new", "call-new", AssistantActivity.WRITING))

        assertEquals(2L, replacement.generation)
        assertEquals(
            AssistantActivity.WRITING,
            ledger.apply(VoiceProcessEvent.RunFinished("run-old")).activity,
        )
        assertEquals(
            AssistantActivity.WRITING,
            ledger.apply(VoiceProcessEvent.ToolFinished("run-old", "exec-old", "call-old")).activity,
        )
    }

    @Test
    fun adoptsAnAlreadyRunningProcessWhenObservationBeginsMidRun() {
        val ledger = AssistantProcessActivityLedger()

        val state = ledger.apply(
            toolStarted("run-live", "read-live", "call-live", AssistantActivity.READING),
        )

        assertTrue(state.active)
        assertEquals(AssistantActivity.READING, state.activity)
    }

    @Test
    fun unknownToolsKeepTheRunActiveWithoutInventingAVisual() {
        val ledger = AssistantProcessActivityLedger()
        ledger.apply(VoiceProcessEvent.RunStarted("run-1"))

        val state = ledger.apply(toolStarted("run-1", "other-1", "call-1", null))

        assertTrue(state.active)
        assertEquals(AssistantActivity.NONE, state.activity)
    }

    @Test
    fun resetAdvancesTheGenerationWithoutRetainingAnActivity() {
        val ledger = AssistantProcessActivityLedger()
        ledger.apply(VoiceProcessEvent.RunStarted("run-1"))
        ledger.apply(toolStarted("run-1", "read-1", "call-1", AssistantActivity.READING))

        val reset = ledger.reset()

        assertFalse(reset.active)
        assertEquals(AssistantActivity.NONE, reset.activity)
        assertEquals(2L, reset.generation)
    }

    private fun toolStarted(
        runId: String,
        executionId: String,
        callId: String,
        activity: AssistantActivity?,
    ) = VoiceProcessEvent.ToolStarted(runId, executionId, callId, activity)
}
