package com.humansandmachines.gsv.wear.voice

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AssistantActivityPresenterTest {
    @Test
    fun holdsABriefActivityLongEnoughToReadThenReleasesIt() = runTest {
        var nowMillis = 10_000L
        var published = AssistantProcessState()
        val presenter = AssistantActivityPresenter(
            scope = this,
            publish = { published = it },
            nowMillis = { nowMillis },
            minimumVisibleMillis = 720L,
        )

        presenter.update(
            AssistantProcessState(active = true, activity = AssistantActivity.READING),
        )
        nowMillis += 100L
        presenter.update(AssistantProcessState())

        assertFalse(published.active)
        assertEquals(AssistantActivity.READING, published.activity)
        advanceTimeBy(619L)
        runCurrent()
        assertEquals(AssistantActivity.READING, published.activity)
        advanceTimeBy(1L)
        runCurrent()
        assertEquals(AssistantActivity.NONE, published.activity)
    }

    @Test
    fun aNewActivityCancelsThePendingRelease() = runTest {
        var nowMillis = 2_000L
        var published = AssistantProcessState()
        val presenter = AssistantActivityPresenter(
            scope = this,
            publish = { published = it },
            nowMillis = { nowMillis },
            minimumVisibleMillis = 720L,
        )
        presenter.update(
            AssistantProcessState(active = true, activity = AssistantActivity.READING),
        )
        nowMillis += 100L
        presenter.update(AssistantProcessState(active = true))
        nowMillis += 80L
        presenter.update(
            AssistantProcessState(active = true, activity = AssistantActivity.EXECUTING),
        )

        advanceTimeBy(620L)
        runCurrent()
        assertEquals(AssistantActivity.EXECUTING, published.activity)
    }
}
