package com.humansandmachines.gsv.wear.voice

import java.util.ArrayDeque
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal class AssistantActivityPresenter(
    private val scope: CoroutineScope,
    private val publish: (AssistantProcessState) -> Unit,
    private val nowMillis: () -> Long = { System.nanoTime() / 1_000_000L },
    private val minimumVisibleMillis: Long = MINIMUM_VISIBLE_MILLIS,
) {
    private var advance: Job? = null
    private var latest = AssistantProcessState()
    private var generation = latest.generation
    private var observedActivity = AssistantActivity.NONE
    private var visibleActivity = AssistantActivity.NONE
    private var visibleSinceMillis = 0L
    private val pendingActivities = ArrayDeque<AssistantActivity>()

    fun update(state: AssistantProcessState) {
        if (state.generation != generation) {
            clearPresentation()
            generation = state.generation
            observedActivity = AssistantActivity.NONE
        }
        latest = state
        val incomingActivity = state.activity
        val activityChanged = incomingActivity != observedActivity
        observedActivity = incomingActivity
        if (
            incomingActivity != AssistantActivity.NONE &&
            (activityChanged || visibleActivity == AssistantActivity.NONE)
        ) {
            presentOrQueue(incomingActivity)
        }
        publishLatest()
        scheduleAdvanceIfNeeded()
    }

    fun reset() {
        clearPresentation()
        latest = AssistantProcessState()
        generation = latest.generation
        observedActivity = AssistantActivity.NONE
        publish(latest)
    }

    private fun presentOrQueue(activity: AssistantActivity) {
        if (visibleActivity == AssistantActivity.NONE) {
            visibleActivity = activity
            visibleSinceMillis = nowMillis()
            return
        }
        if (visibleActivity == activity && pendingActivities.isEmpty()) {
            visibleSinceMillis = nowMillis()
            return
        }
        if (pendingActivities.peekLast() == activity) return
        if (pendingActivities.size >= MAX_PENDING_ACTIVITIES) pendingActivities.removeFirst()
        pendingActivities.addLast(activity)
    }

    private fun scheduleAdvanceIfNeeded() {
        advance?.cancel()
        advance = null
        if (
            visibleActivity == AssistantActivity.NONE ||
            pendingActivities.isEmpty() && observedActivity == visibleActivity
        ) {
            return
        }
        val remaining = (
            visibleSinceMillis + minimumVisibleMillis - nowMillis()
        ).coerceAtLeast(0L)
        advance = scope.launch {
            delay(remaining)
            advance = null
            advancePresentation()
        }
    }

    private fun advancePresentation() {
        val next = when {
            pendingActivities.isNotEmpty() -> pendingActivities.removeFirst()
            observedActivity != AssistantActivity.NONE -> observedActivity
            else -> AssistantActivity.NONE
        }
        visibleActivity = next
        visibleSinceMillis = if (next == AssistantActivity.NONE) 0L else nowMillis()
        publishLatest()
        scheduleAdvanceIfNeeded()
    }

    private fun publishLatest() {
        publish(latest.copy(visualActivity = visibleActivity))
    }

    private fun clearPresentation() {
        advance?.cancel()
        advance = null
        pendingActivities.clear()
        visibleActivity = AssistantActivity.NONE
        visibleSinceMillis = 0L
    }

    private companion object {
        const val MINIMUM_VISIBLE_MILLIS = 1_800L
        const val MAX_PENDING_ACTIVITIES = 2
    }
}
