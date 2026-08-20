package com.humansandmachines.gsv.wear.connection

import com.humansandmachines.gsv.wear.config.DriverConfig
import com.humansandmachines.gsv.wear.protocol.ConnectFailure
import com.humansandmachines.gsv.wear.protocol.GsvProtocol
import com.humansandmachines.gsv.wear.protocol.IncomingTextFrame
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

class DriverSession(
    override val epoch: Long,
    private val config: DriverConfig,
    private val client: OkHttpClient,
    private val scope: CoroutineScope,
    dispatcherFactory: DriverRequestDispatcherFactory,
    private val onReady: (Long) -> Unit,
    private val onTerminated: (Long, ConnectFailure) -> Unit,
) : WebSocketListener(), DriverTransport {
    private val terminal = AtomicBoolean(false)
    private val connectRequestId = "connect-${UUID.randomUUID()}"
    private val dispatcher = dispatcherFactory.create(this)
    private var handshakeComplete = false
    private var handshakeTimeout: Job? = null
    private var webSocket: WebSocket? = null

    fun open() {
        val request = Request.Builder().url(config.gatewayUrl).build()
        webSocket = client.newWebSocket(request, this)
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        if (terminal.get()) {
            webSocket.cancel()
            return
        }
        if (!webSocket.send(GsvProtocol.connectFrame(connectRequestId, config))) {
            terminate(ConnectFailure.NETWORK)
            return
        }
        handshakeTimeout = scope.launch {
            delay(HANDSHAKE_TIMEOUT_MILLIS)
            if (!handshakeComplete) terminate(ConnectFailure.NETWORK)
        }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        if (terminal.get()) return
        val frame = try {
            GsvProtocol.parseText(text)
        } catch (_: Exception) {
            terminate(ConnectFailure.PROTOCOL)
            return
        }
        if (!handshakeComplete) {
            if (frame !is IncomingTextFrame.Response || frame.id != connectRequestId) {
                terminate(ConnectFailure.PROTOCOL)
                return
            }
            val failure = GsvProtocol.validateConnectResponse(frame.json, config.deviceId)
            if (failure != null) {
                terminate(failure)
                return
            }
            handshakeComplete = true
            handshakeTimeout?.cancel()
            onReady(epoch)
            return
        }

        when (frame) {
            is IncomingTextFrame.Request -> dispatcher.onRequest(frame.request)
            is IncomingTextFrame.RequestCancel -> dispatcher.onRequestCancel(frame.id)
            else -> Unit
        }
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        if (handshakeComplete && !terminal.get()) dispatcher.onBinary(bytes.toByteArray())
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        terminate(ConnectFailure.CLOSED)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        terminate(ConnectFailure.NETWORK)
    }

    override fun sendText(text: String): Boolean =
        !terminal.get() && webSocket?.send(text) == true

    override fun sendBinary(bytes: ByteArray): Boolean =
        !terminal.get() && webSocket?.send(bytes.toByteString()) == true

    fun close() {
        terminate(ConnectFailure.CLOSED)
    }

    private fun terminate(reason: ConnectFailure) {
        if (!terminal.compareAndSet(false, true)) return
        handshakeTimeout?.cancel()
        dispatcher.close()
        webSocket?.cancel()
        onTerminated(epoch, reason)
    }

    companion object {
        private const val HANDSHAKE_TIMEOUT_MILLIS = 15_000L
    }
}
