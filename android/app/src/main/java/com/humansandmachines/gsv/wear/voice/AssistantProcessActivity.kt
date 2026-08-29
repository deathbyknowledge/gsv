package com.humansandmachines.gsv.wear.voice

import java.util.LinkedHashMap

enum class AssistantActivity {
    NONE,
    READING,
    WRITING,
    SEARCHING,
    EXECUTING,
    DELETING,
}

data class AssistantProcessState(
    val active: Boolean = false,
    val activity: AssistantActivity = AssistantActivity.NONE,
)

internal sealed interface VoiceProcessEvent {
    val runId: String

    data class RunStarted(
        override val runId: String,
    ) : VoiceProcessEvent

    data class RunActive(
        override val runId: String,
    ) : VoiceProcessEvent

    data class ToolStarted(
        override val runId: String,
        val executionId: String,
        val callId: String,
        val activity: AssistantActivity?,
    ) : VoiceProcessEvent

    data class ToolFinished(
        override val runId: String,
        val executionId: String,
        val callId: String,
    ) : VoiceProcessEvent

    data class RunFinished(
        override val runId: String,
    ) : VoiceProcessEvent
}

internal class AssistantProcessActivityLedger {
    private data class ActiveTool(
        val runId: String,
        val callId: String,
        val activity: AssistantActivity?,
    )

    private var activeRunId: String? = null
    private val activeTools = LinkedHashMap<String, ActiveTool>()

    @Synchronized
    fun apply(event: VoiceProcessEvent): AssistantProcessState {
        when (event) {
            is VoiceProcessEvent.RunStarted -> startRun(event.runId)
            is VoiceProcessEvent.RunActive -> resumeRun(event.runId)
            is VoiceProcessEvent.ToolStarted -> startTool(event)
            is VoiceProcessEvent.ToolFinished -> finishTool(event)
            is VoiceProcessEvent.RunFinished -> finishRun(event.runId)
        }
        return snapshot()
    }

    @Synchronized
    fun reset(): AssistantProcessState {
        activeRunId = null
        activeTools.clear()
        return AssistantProcessState()
    }

    private fun startRun(runId: String) {
        if (activeRunId == runId) return
        activeRunId = runId
        activeTools.clear()
    }

    private fun resumeRun(runId: String) {
        if (!acceptRun(runId)) return
        activeTools.clear()
    }

    private fun startTool(event: VoiceProcessEvent.ToolStarted) {
        if (!acceptRun(event.runId)) return
        val existing = activeTools[event.executionId]
        if (existing != null) return
        if (activeTools.size >= MAX_ACTIVE_TOOLS) {
            activeTools.remove(activeTools.keys.first())
        }
        activeTools[event.executionId] = ActiveTool(
            runId = event.runId,
            callId = event.callId,
            activity = event.activity,
        )
    }

    private fun finishTool(event: VoiceProcessEvent.ToolFinished) {
        if (activeRunId != event.runId) return
        val active = activeTools[event.executionId] ?: return
        if (active.runId != event.runId || active.callId != event.callId) return
        activeTools.remove(event.executionId)
    }

    private fun finishRun(runId: String) {
        if (activeRunId != runId) return
        activeRunId = null
        activeTools.clear()
    }

    private fun acceptRun(runId: String): Boolean {
        if (activeRunId == null) activeRunId = runId
        return activeRunId == runId
    }

    private fun snapshot(): AssistantProcessState = AssistantProcessState(
        active = activeRunId != null,
        activity = activeTools.values.lastOrNull { it.activity != null }?.activity
            ?: AssistantActivity.NONE,
    )

    private companion object {
        const val MAX_ACTIVE_TOOLS = 64
    }
}
