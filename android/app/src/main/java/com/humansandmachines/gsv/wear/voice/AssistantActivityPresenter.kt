package com.humansandmachines.gsv.wear.voice

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
    private var release: Job? = null
    private var latest = AssistantProcessState()
    private var visibleActivity = AssistantActivity.NONE
    private var visibleSinceMillis = 0L

    fun update(state: AssistantProcessState) {
        latest = state
        if (state.activity != AssistantActivity.NONE) {
            release?.cancel()
            release = null
            if (visibleActivity != state.activity) {
                visibleActivity = state.activity
                visibleSinceMillis = nowMillis()
            }
            publish(state)
            return
        }

        if (visibleActivity == AssistantActivity.NONE) {
            publish(state)
            return
        }

        publish(state.copy(activity = visibleActivity))
        release?.cancel()
        val remaining = (
            visibleSinceMillis + minimumVisibleMillis - nowMillis()
        ).coerceAtLeast(0L)
        release = scope.launch {
            delay(remaining)
            if (latest.activity == AssistantActivity.NONE) {
                visibleActivity = AssistantActivity.NONE
                publish(latest)
            }
            release = null
        }
    }

    fun reset() {
        release?.cancel()
        release = null
        latest = AssistantProcessState()
        visibleActivity = AssistantActivity.NONE
        visibleSinceMillis = 0L
        publish(latest)
    }

    private companion object {
        const val MINIMUM_VISIBLE_MILLIS = 720L
    }
}
