package com.humansandmachines.gsv.wear.connection

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import com.humansandmachines.gsv.wear.config.DriverConfig
import com.humansandmachines.gsv.wear.protocol.ConnectFailure
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

enum class ConnectionState {
    DISCONNECTED,
    OFFLINE,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
}

data class ConnectionStatus(
    val state: ConnectionState,
    val failure: ConnectFailure? = null,
)

class ConnectionSupervisor(
    context: Context,
    private val scope: CoroutineScope,
    private val config: DriverConfig,
    private val dispatcherFactory: DriverRequestDispatcherFactory,
    private val onStatus: (ConnectionStatus) -> Unit,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .build(),
    private val reconnectPolicy: ReconnectPolicy = ReconnectPolicy(),
) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val events = Channel<Event>(Channel.UNLIMITED)
    private val epochs = ConnectionEpoch()
    private val stopped = AtomicBoolean(false)
    private var actor: Job? = null
    private var retry: Job? = null
    private var activeNetwork: Network? = null
    private var session: DriverSession? = null

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            events.trySend(Event.NetworkAvailable(network))
        }

        override fun onLost(network: Network) {
            events.trySend(Event.NetworkLost(network))
        }
    }

    fun start() {
        check(actor == null) { "Connection supervisor already started" }
        actor = scope.launch {
            eventLoop()
        }
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
        runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
        events.close()
        actor?.cancel()
        actor = null
        onStatus(ConnectionStatus(ConnectionState.DISCONNECTED))
    }

    private suspend fun eventLoop() {
        for (event in events) {
            when (event) {
                is Event.Start -> {
                    activeNetwork = event.network
                    if (activeNetwork == null) {
                        onStatus(ConnectionStatus(ConnectionState.OFFLINE))
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
                        onStatus(ConnectionStatus(ConnectionState.OFFLINE))
                    }
                }
                is Event.Ready -> {
                    if (!epochs.isCurrent(event.epoch)) continue
                    reconnectPolicy.reset()
                    onStatus(ConnectionStatus(ConnectionState.CONNECTED))
                }
                is Event.Terminated -> {
                    if (!epochs.isCurrent(event.epoch)) continue
                    session = null
                    if (activeNetwork == null) {
                        onStatus(ConnectionStatus(ConnectionState.OFFLINE, event.reason))
                    } else {
                        scheduleRetry(event.epoch, event.reason)
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
        val epoch = epochs.next()
        onStatus(ConnectionStatus(state))
        session = DriverSession(
            epoch = epoch,
            config = config,
            client = client,
            scope = scope,
            dispatcherFactory = dispatcherFactory,
            onReady = { events.trySend(Event.Ready(it)) },
            onTerminated = { endedEpoch, reason ->
                events.trySend(Event.Terminated(endedEpoch, reason))
            },
        ).also(DriverSession::open)
    }

    private fun scheduleRetry(epoch: Long, reason: ConnectFailure) {
        val delayMillis = reconnectPolicy.nextDelayMillis()
        onStatus(ConnectionStatus(ConnectionState.RECONNECTING, reason))
        retry?.cancel()
        retry = scope.launch {
            delay(delayMillis)
            events.send(Event.Retry(epoch))
        }
    }

    private sealed interface Event {
        data class Start(val network: Network?) : Event
        data class NetworkAvailable(val network: Network) : Event
        data class NetworkLost(val network: Network) : Event
        data class Ready(val epoch: Long) : Event
        data class Terminated(val epoch: Long, val reason: ConnectFailure) : Event
        data class Retry(val epoch: Long) : Event
    }
}
