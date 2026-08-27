package com.humansandmachines.gsv.wear.runtime

import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.connection.ConnectionState
import com.humansandmachines.gsv.wear.connection.ConnectionStatus
import com.humansandmachines.gsv.wear.protocol.ConnectFailure
import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

enum class CameraState {
    CLOSED,
    OPENING,
    ACTIVE,
    CLOSING,
}

enum class MicrophoneState {
    CLOSED,
    OPENING,
    ACTIVE,
    CLOSING,
}

data class RuntimeSnapshot(
    val connection: ConnectionState = ConnectionState.DISCONNECTED,
    val connectionFailure: ConnectFailure? = null,
    val authority: AuthorityState = AuthorityState.DISARMED,
    val camera: CameraState = CameraState.CLOSED,
    val microphone: MicrophoneState = MicrophoneState.CLOSED,
    val voiceConnection: ConnectionState = ConnectionState.DISCONNECTED,
    val voiceTurn: VoiceTurnState = VoiceTurnState.IDLE,
    val voiceLevel: Float = 0f,
)

object WearRuntimeState {
    private val mutableSnapshot = MutableStateFlow(RuntimeSnapshot())
    val snapshot: StateFlow<RuntimeSnapshot> = mutableSnapshot.asStateFlow()

    fun setConnection(status: ConnectionStatus) {
        mutableSnapshot.update {
            it.copy(connection = status.state, connectionFailure = status.failure)
        }
    }

    fun setAuthority(state: AuthorityState) {
        mutableSnapshot.update { it.copy(authority = state) }
    }

    fun setCamera(state: CameraState) {
        mutableSnapshot.update { it.copy(camera = state) }
    }

    fun setMicrophone(state: MicrophoneState) {
        mutableSnapshot.update { it.copy(microphone = state) }
    }

    fun setVoiceConnection(state: ConnectionState) {
        mutableSnapshot.update { it.copy(voiceConnection = state) }
    }

    fun setVoiceTurn(state: VoiceTurnState) {
        mutableSnapshot.update {
            it.copy(
                voiceTurn = state,
                voiceLevel = if (state == VoiceTurnState.LISTENING) it.voiceLevel else 0f,
            )
        }
    }

    fun setVoiceLevel(level: Float) {
        mutableSnapshot.update {
            if (it.voiceTurn == VoiceTurnState.LISTENING) {
                it.copy(voiceLevel = level.coerceIn(0f, 1f))
            } else {
                it
            }
        }
    }

    fun reset() {
        mutableSnapshot.value = RuntimeSnapshot()
    }
}
