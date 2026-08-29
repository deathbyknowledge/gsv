package com.humansandmachines.gsv.wear.voice

import com.humansandmachines.gsv.wear.connection.ConnectionState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class AssistantSnapshot(
    val connection: ConnectionState = ConnectionState.DISCONNECTED,
    val turn: VoiceTurnState = VoiceTurnState.IDLE,
    val turnId: Long = 0,
    val level: Float = 0f,
    val processActive: Boolean = false,
    val processActivity: AssistantActivity = AssistantActivity.NONE,
    val activity: AssistantActivity = AssistantActivity.NONE,
)

object AssistantRuntimeState {
    private val mutableSnapshot = MutableStateFlow(AssistantSnapshot())
    val snapshot: StateFlow<AssistantSnapshot> = mutableSnapshot.asStateFlow()

    fun setConnection(state: ConnectionState) {
        mutableSnapshot.update { it.copy(connection = state) }
    }

    fun setTurn(state: VoiceTurnState) {
        mutableSnapshot.update {
            it.copy(
                turn = state,
                turnId = if (it.turn == VoiceTurnState.IDLE && state != VoiceTurnState.IDLE) {
                    it.turnId + 1
                } else {
                    it.turnId
                },
                level = if (state.isAudioReactive()) it.level else 0f,
            )
        }
    }

    fun setLevel(level: Float) {
        mutableSnapshot.update {
            if (it.turn.isAudioReactive()) {
                it.copy(level = level.coerceIn(0f, 1f))
            } else {
                it
            }
        }
    }

    fun setProcessState(state: AssistantProcessState) {
        mutableSnapshot.update {
            it.copy(
                processActive = state.active,
                processActivity = state.activity,
                activity = state.visualActivity,
            )
        }
    }

    fun reset() {
        mutableSnapshot.value = AssistantSnapshot()
    }

    private fun VoiceTurnState.isAudioReactive(): Boolean =
        this == VoiceTurnState.LISTENING || this == VoiceTurnState.SPEAKING
}
