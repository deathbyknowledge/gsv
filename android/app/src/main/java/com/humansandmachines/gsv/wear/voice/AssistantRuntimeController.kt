package com.humansandmachines.gsv.wear.voice

import android.content.Context
import com.humansandmachines.gsv.wear.BuildConfig
import com.humansandmachines.gsv.wear.actions.AndroidActionController
import com.humansandmachines.gsv.wear.audio.AudioController
import com.humansandmachines.gsv.wear.audio.MicrophoneCapturePriority
import com.humansandmachines.gsv.wear.config.DriverConfigStore
import com.humansandmachines.gsv.wear.config.VoiceClientConfig
import com.humansandmachines.gsv.wear.connection.ConnectionState
import java.io.Closeable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class AssistantRuntimeController(context: Context) : Closeable {
    private val applicationContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val microphone = AudioController(
        context = applicationContext,
        onState = {},
        priority = MicrophoneCapturePriority.ASSISTANT,
    )
    private val actions = AndroidActionController(applicationContext)
    private val activityPresenter = AssistantActivityPresenter(
        scope = scope,
        publish = AssistantRuntimeState::setProcessState,
    )
    private val coordinator = VoiceTurnCoordinator(
        microphone = microphone,
        actions = actions,
        audio = VoiceAudioController(applicationContext),
        client = { connection },
        publishState = AssistantRuntimeState::setTurn,
        publishLevel = AssistantRuntimeState::setLevel,
    )
    private var connection: VoiceClientSupervisor? = null
    private var connectionConfig: VoiceClientConfig? = null
    private var closed = false

    init {
        VoiceAssistantRuntime.attach(coordinator)
        reload()
    }

    @Synchronized
    fun reload() {
        if (closed) return
        val config = runCatching {
            DriverConfigStore(applicationContext).loadVoice(BuildConfig.DEBUG)
        }.getOrNull()
        if (config != null && sameConnection(config, connectionConfig) && connection != null) return

        connection?.stop()
        connection = null
        connectionConfig = null
        activityPresenter.reset()
        AssistantRuntimeState.setConnection(ConnectionState.DISCONNECTED)
        if (config == null) return

        connectionConfig = config
        connection = VoiceClientSupervisor(
            context = applicationContext,
            scope = scope,
            config = config,
            onStatus = ::setConnectionStatus,
            onProcessState = activityPresenter::update,
        ).also(VoiceClientSupervisor::start)
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        VoiceAssistantRuntime.detach(coordinator)
        connection?.stop()
        connection = null
        connectionConfig = null
        activityPresenter.reset()
        coordinator.close()
        microphone.close()
        actions.close()
        scope.cancel(CancellationException("Assistant runtime destroyed"))
        AssistantRuntimeState.reset()
    }

    private fun sameConnection(first: VoiceClientConfig, second: VoiceClientConfig?): Boolean =
        second != null &&
            first.gatewayUrl == second.gatewayUrl &&
            first.username == second.username &&
            first.clientId == second.clientId &&
            first.token == second.token

    private fun setConnectionStatus(state: ConnectionState) {
        if (state != ConnectionState.CONNECTED) activityPresenter.reset()
        AssistantRuntimeState.setConnection(state)
    }
}
