package com.humansandmachines.gsv.wear.voice

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import com.humansandmachines.gsv.wear.config.VoiceClientConfig
import com.humansandmachines.gsv.wear.connection.ConnectionEpoch
import com.humansandmachines.gsv.wear.connection.ConnectionState
import com.humansandmachines.gsv.wear.connection.ReconnectPolicy
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient

class VoiceClientSupervisor(
    context: Context,
    private val scope: CoroutineScope,
    private val config: VoiceClientConfig,
    private val onStatus: (ConnectionState) -> Unit,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build(),
    private val reconnectPolicy: ReconnectPolicy = ReconnectPolicy(),
) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val events = Channel<Event>(Channel.UNLIMITED)
    private val epochs = ConnectionEpoch()
    private val stopped = AtomicBoolean(false)
    private val activeSession = MutableStateFlow<VoiceClientSession?>(null)
    private var actor: Job? = null
    private var retry: Job? = null
    private var activeNetwork: Network? = null
    private var session: VoiceClientSession? = null

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            events.trySend(Event.NetworkAvailable(network))
        }

        override fun onLost(network: Network) {
            events.trySend(Event.NetworkLost(network))
        }
    }

    fun start() {
        check(actor == null) { "Voice client supervisor already started" }
        actor = scope.launch { eventLoop() }
        events.trySend(Event.Start(connectivity.activeNetwork))
        connectivity.registerDefaultNetworkCallback(networkCallback)
    }

    fun stop() {
        if (!stopped.compareAndSet(false, true)) return
        retry?.cancel()
        retry = null
        epochs.invalidate()
        session?.close()
        session = null
        activeSession.value = null
        runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
        events.close()
        actor?.cancel()
        actor = null
        onStatus(ConnectionState.DISCONNECTED)
    }

    suspend fun awaitSession(timeoutMillis: Long = CONNECT_WAIT_MILLIS): VoiceClientSession =
        withTimeout(timeoutMillis) { activeSession.filterNotNull().first() }

    private suspend fun eventLoop() {
        for (event in events) {
            when (event) {
                is Event.Start -> {
                    activeNetwork = event.network
                    if (activeNetwork == null) {
                        onStatus(ConnectionState.OFFLINE)
                    } else {
                        connectNow(ConnectionState.CONNECTING)
                    }
                }
                is Event.NetworkAvailable -> {
                    val changed = activeNetwork != event.network
                    activeNetwork = event.network
                    if (changed || session == null) connectNow(ConnectionState.CONNECTING)
                }
                is Event.NetworkLost -> {
                    if (activeNetwork == event.network) {
                        activeNetwork = null
                        retry?.cancel()
                        retry = null
                        epochs.invalidate()
                        session?.close()
                        session = null
                        activeSession.value = null
                        onStatus(ConnectionState.OFFLINE)
                    }
                }
                is Event.Ready -> {
                    if (!epochs.isCurrent(event.epoch)) continue
                    reconnectPolicy.reset()
                    activeSession.value = session
                    onStatus(ConnectionState.CONNECTED)
                }
                is Event.Terminated -> {
                    if (!epochs.isCurrent(event.epoch)) continue
                    session = null
                    activeSession.value = null
                    if (activeNetwork == null) {
                        onStatus(ConnectionState.OFFLINE)
                    } else {
                        scheduleRetry(event.epoch)
                    }
                }
                is Event.Retry -> {
                    if (epochs.isCurrent(event.epoch) && session == null && activeNetwork != null) {
                        connectNow(ConnectionState.RECONNECTING)
                    }
                }
            }
        }
    }

    private fun connectNow(state: ConnectionState) {
        if (stopped.get()) return
        retry?.cancel()
        retry = null
        epochs.invalidate()
        session?.close()
        activeSession.value = null
        val epoch = epochs.next()
        onStatus(state)
        session = VoiceClientSession(
            epoch = epoch,
            config = VoiceSessionConfig(
                gatewayUrl = config.gatewayUrl,
                username = config.username,
                clientId = config.clientId,
                credential = VoiceCredential.Token(config.token),
            ),
            client = client,
            scope = scope,
            discoverPersonalProcess = true,
            onReady = { events.trySend(Event.Ready(it)) },
            onTerminated = { endedEpoch, _ -> events.trySend(Event.Terminated(endedEpoch)) },
        ).also(VoiceClientSession::open)
    }

    private fun scheduleRetry(epoch: Long) {
        onStatus(ConnectionState.RECONNECTING)
        retry?.cancel()
        retry = scope.launch {
            delay(reconnectPolicy.nextDelayMillis())
            events.send(Event.Retry(epoch))
        }
    }

    private sealed interface Event {
        data class Start(val network: Network?) : Event
        data class NetworkAvailable(val network: Network) : Event
        data class NetworkLost(val network: Network) : Event
        data class Ready(val epoch: Long) : Event
        data class Terminated(val epoch: Long) : Event
        data class Retry(val epoch: Long) : Event
    }

    companion object {
        private const val CONNECT_WAIT_MILLIS = 10_000L
    }
}
