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
    fun holdsABriefVisualWhilePublishingImmediateProcessCompletion() = runTest {
        var nowMillis = 10_000L
        var published = AssistantProcessState()
        val presenter = AssistantActivityPresenter(
            scope = this,
            publish = { published = it },
            nowMillis = { nowMillis },
            minimumVisibleMillis = 1_800L,
        )

        presenter.update(
            AssistantProcessState(
                active = true,
                activity = AssistantActivity.READING,
                generation = 1L,
            ),
        )
        nowMillis += 100L
        presenter.update(AssistantProcessState(generation = 1L))

        assertFalse(published.active)
        assertEquals(AssistantActivity.NONE, published.activity)
        assertEquals(AssistantActivity.READING, published.visualActivity)
        nowMillis += 1_699L
        advanceTimeBy(1_699L)
        runCurrent()
        assertEquals(AssistantActivity.READING, published.visualActivity)
        nowMillis += 1L
        advanceTimeBy(1L)
        runCurrent()
        assertEquals(AssistantActivity.NONE, published.visualActivity)
    }

    @Test
    fun rapidActivitiesMorphDirectlyInTheirObservedOrder() = runTest {
        var nowMillis = 2_000L
        val published = mutableListOf<AssistantProcessState>()
        val presenter = AssistantActivityPresenter(
            scope = this,
            publish = published::add,
            nowMillis = { nowMillis },
            minimumVisibleMillis = 1_800L,
        )
        presenter.update(
            processState(AssistantActivity.READING),
        )
        nowMillis += 100L
        presenter.update(processState())
        nowMillis += 50L
        presenter.update(processState(AssistantActivity.SEARCHING))
        nowMillis += 50L
        presenter.update(processState())
        nowMillis += 50L
        presenter.update(processState(AssistantActivity.WRITING))
        nowMillis += 50L
        presenter.update(AssistantProcessState(generation = 1L))

        nowMillis += 1_600L
        advanceTimeBy(1_600L)
        runCurrent()
        assertEquals(AssistantActivity.SEARCHING, published.last().visualActivity)

        nowMillis += 1_800L
        advanceTimeBy(1_800L)
        runCurrent()
        assertEquals(AssistantActivity.WRITING, published.last().visualActivity)

        nowMillis += 1_800L
        advanceTimeBy(1_800L)
        runCurrent()
        assertEquals(AssistantActivity.NONE, published.last().visualActivity)
        assertEquals(
            listOf(
                AssistantActivity.READING,
                AssistantActivity.SEARCHING,
                AssistantActivity.WRITING,
                AssistantActivity.NONE,
            ),
            published.map(AssistantProcessState::visualActivity).distinctConsecutive(),
        )
    }

    @Test
    fun aNewProcessGenerationClearsQueuedAfterimagesImmediately() = runTest {
        var nowMillis = 4_000L
        var published = AssistantProcessState()
        val presenter = AssistantActivityPresenter(
            scope = this,
            publish = { published = it },
            nowMillis = { nowMillis },
            minimumVisibleMillis = 1_800L,
        )
        presenter.update(processState(AssistantActivity.READING, generation = 1L))
        nowMillis += 100L
        presenter.update(processState(AssistantActivity.SEARCHING, generation = 1L))

        presenter.update(AssistantProcessState(active = true, generation = 2L))

        assertEquals(AssistantActivity.NONE, published.activity)
        assertEquals(AssistantActivity.NONE, published.visualActivity)
        nowMillis += 4_000L
        advanceTimeBy(4_000L)
        runCurrent()
        assertEquals(AssistantActivity.NONE, published.visualActivity)
    }

    private fun processState(
        activity: AssistantActivity = AssistantActivity.NONE,
        generation: Long = 1L,
    ) = AssistantProcessState(
        active = true,
        activity = activity,
        generation = generation,
    )

    private fun <T> List<T>.distinctConsecutive(): List<T> = buildList {
        this@distinctConsecutive.forEach { value ->
            if (lastOrNull() != value) add(value)
        }
    }
}
