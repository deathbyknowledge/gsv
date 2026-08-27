package com.humansandmachines.gsv.wear.voice

import com.humansandmachines.gsv.wear.protocol.BinaryFrameCodec
import com.humansandmachines.gsv.wear.protocol.BodyDescriptor
import java.io.ByteArrayOutputStream
import java.util.LinkedHashMap
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

class VoiceClientSession(
    val epoch: Long,
    private val config: VoiceSessionConfig,
    private val client: OkHttpClient,
    private val scope: CoroutineScope,
    private val discoverPersonalProcess: Boolean,
    private val onReady: (Long) -> Unit,
    private val onTerminated: (Long, Throwable) -> Unit,
) : WebSocketListener() {
    private val terminal = AtomicBoolean(false)
    private val connectRequestId = "voice-connect-${UUID.randomUUID()}"
    private val nextStreamId = AtomicLong(1L)
    private val ready = CompletableDeferred<VoiceConnectResult>()
    private val pending = ConcurrentHashMap<String, PendingRequest>()
    private val incomingBodies = ConcurrentHashMap<Long, IncomingBody>()
    private val runWaiters = ConcurrentHashMap<String, CompletableDeferred<VoiceRunTerminal>>()
    private val terminalRunLock = Any()
    private val terminalRuns = object : LinkedHashMap<String, VoiceRunTerminal>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, VoiceRunTerminal>?): Boolean =
            size > MAX_CACHED_RUNS
    }
    private var handshakeComplete = false
    private var handshakeTimeout: Job? = null
    private var webSocket: WebSocket? = null

    @Volatile
    private var connectInfo: VoiceConnectResult? = null

    @Volatile
    var shipHandlerPid: String? = null
        private set

    @Volatile
    var shipConversationId: String? = null
        private set

    fun open() {
        webSocket = client.newWebSocket(Request.Builder().url(config.gatewayUrl).build(), this)
    }

    suspend fun awaitReady(): VoiceConnectResult = withTimeout(HANDSHAKE_TIMEOUT_MILLIS) { ready.await() }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        if (terminal.get()) {
            webSocket.cancel()
            return
        }
        if (!webSocket.send(VoiceProtocol.connectFrame(connectRequestId, config))) {
            terminate(VoiceClientFailure("Voice WebSocket could not send its handshake"))
            return
        }
        handshakeTimeout = scope.launch {
            delay(HANDSHAKE_TIMEOUT_MILLIS)
            if (!handshakeComplete) terminate(VoiceClientFailure("Voice client handshake timed out"))
        }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        if (terminal.get()) return
        val json = try {
            JSONObject(text)
        } catch (_: Exception) {
            terminate(VoiceClientFailure("Voice client received an invalid protocol frame"))
            return
        }
        when (json.optString("type")) {
            "res" -> handleResponse(json)
            "sig" -> if (handshakeComplete) handleSignal(json)
        }
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        if (handshakeComplete && !terminal.get()) handleBinary(bytes.toByteArray())
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        terminate(VoiceClientFailure("Voice WebSocket closed"))
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        terminate(VoiceClientFailure("Voice WebSocket failed"))
    }

    suspend fun request(
        call: String,
        args: JSONObject = JSONObject(),
        body: ByteArray? = null,
        timeoutMillis: Long = DEFAULT_REQUEST_TIMEOUT_MILLIS,
    ): VoiceResponse {
        if (!handshakeComplete || terminal.get()) throw VoiceClientFailure("Voice client is not connected")
        val requestId = "voice-${UUID.randomUUID()}"
        val streamId = body?.let { allocateStreamId() }
        val descriptor = streamId?.let { BodyDescriptor(it, body.size.toLong()) }
        val deferred = CompletableDeferred<VoiceResponse>()
        pending[requestId] = PendingRequest(deferred)
        if (webSocket?.send(VoiceProtocol.requestFrame(requestId, call, args, descriptor)) != true) {
            pending.remove(requestId)
            throw VoiceClientFailure("Voice request could not be sent")
        }
        try {
            if (body != null && streamId != null) sendBody(streamId, body)
            return withTimeout(timeoutMillis) { deferred.await() }
        } catch (error: Throwable) {
            cancelPending(requestId)
            throw error
        }
    }

    suspend fun transcribe(audio: ByteArray, filename: String): String {
        val pid = shipHandlerPid ?: throw VoiceClientFailure("Ship handler is unavailable")
        val response = request(
            call = "ai.transcription.create",
            args = JSONObject()
                .put("pid", pid)
                .put("audio", JSONObject().put("mimeType", "audio/wav").put("filename", filename)),
            body = audio,
            timeoutMillis = TRANSCRIPTION_TIMEOUT_MILLIS,
        )
        return response.data.optString("text").trim()
            .takeIf(String::isNotBlank)
            ?: throw VoiceClientFailure("No speech was recognized")
    }

    suspend fun sendToShip(message: String): String {
        val conversationId = shipConversationId ?: throw VoiceClientFailure("Ship conversation is unavailable")
        val response = request(
            call = "conversation.send",
            args = JSONObject()
                .put("conversationId", conversationId)
                .put("text", message)
                .put("idempotencyKey", UUID.randomUUID().toString()),
        )
        response.data.optString("handlerPid").takeIf(String::isNotBlank)?.let { shipHandlerPid = it }
        return response.data.optString("runId").takeIf(String::isNotBlank)
            ?: throw VoiceClientFailure("Ship conversation did not start a run")
    }

    suspend fun awaitRun(runId: String): VoiceRunTerminal {
        val waiter = CompletableDeferred<VoiceRunTerminal>()
        synchronized(terminalRunLock) {
            terminalRuns.remove(runId)?.let { return it }
            runWaiters[runId] = waiter
            terminalRuns.remove(runId)?.let {
                runWaiters.remove(runId, waiter)
                return it
            }
        }
        return try {
            withTimeout(RUN_TIMEOUT_MILLIS) { waiter.await() }
        } finally {
            runWaiters.remove(runId, waiter)
        }
    }

    suspend fun synthesize(text: String): SynthesizedVoice {
        val response = request(
            call = "ai.speech.create",
            args = JSONObject()
                .put("text", text)
                .put("textFormat", "markdown"),
            timeoutMillis = SPEECH_TIMEOUT_MILLIS,
        )
        val audio = response.data.optJSONObject("audio")
            ?: throw VoiceClientFailure("Speech response metadata was missing")
        val mimeType = audio.optString("mimeType").takeIf(String::isNotBlank)
            ?: throw VoiceClientFailure("Speech response MIME type was missing")
        val bytes = response.body?.takeIf(ByteArray::isNotEmpty)
            ?: throw VoiceClientFailure("Speech response audio was missing")
        return SynthesizedVoice(bytes, mimeType)
    }

    fun supports(call: String): Boolean = connectInfo?.calls?.let { VoiceProtocol.allows(it, call) } == true

    fun close() {
        terminate(VoiceClientFailure("Voice client stopped"))
    }

    private fun handleResponse(json: JSONObject) {
        val id = json.optString("id")
        if (!handshakeComplete) {
            if (id != connectRequestId) {
                terminate(VoiceClientFailure("Voice client handshake response was invalid"))
                return
            }
            val connect = try {
                VoiceProtocol.validateConnectResponse(json, config.clientId)
            } catch (error: Throwable) {
                terminate(error)
                return
            }
            handshakeComplete = true
            connectInfo = connect
            handshakeTimeout?.cancel()
            if (discoverPersonalProcess) {
                scope.launch { finishRuntimeHandshake(connect) }
            } else {
                ready.complete(connect)
                onReady(epoch)
            }
            return
        }

        val request = pending[id] ?: return
        if (!json.optBoolean("ok")) {
            pending.remove(id)
            val message = json.optJSONObject("error")?.optString("message").orEmpty()
            request.deferred.completeExceptionally(
                VoiceClientFailure(message.ifBlank { "Voice request failed" }),
            )
            return
        }
        val data = json.optJSONObject("data") ?: JSONObject()
        val descriptor = try {
            VoiceProtocol.parseBodyDescriptor(json.optJSONObject("body"))
        } catch (error: Throwable) {
            pending.remove(id)
            request.deferred.completeExceptionally(error)
            return
        }
        if (descriptor == null) {
            pending.remove(id)
            request.deferred.complete(VoiceResponse(data))
            return
        }
        if (descriptor.length != null && descriptor.length > MAX_RESPONSE_BODY_BYTES) {
            pending.remove(id)
            sendBodyCancel(descriptor.streamId, "Voice response body is too large")
            request.deferred.completeExceptionally(VoiceClientFailure("Voice response body is too large"))
            return
        }
        incomingBodies[descriptor.streamId] = IncomingBody(id, data, descriptor.length)
    }

    private suspend fun finishRuntimeHandshake(connect: VoiceConnectResult) {
        try {
            val missingCalls = REQUIRED_RUNTIME_CALLS.filterNot { VoiceProtocol.allows(connect.calls, it) }
            if (missingCalls.isNotEmpty()) throw VoiceClientFailure("Voice client call grants are unavailable")
            if (!connect.signals.containsAll(REQUIRED_RUNTIME_SIGNALS)) {
                throw VoiceClientFailure("Voice client signal grants are unavailable")
            }
            val response = request("conversation.ship")
            val conversation = response.data.optJSONObject("conversation")
                ?: throw VoiceClientFailure("Ship conversation could not be resolved")
            if (conversation.optString("kind") != "ship" || conversation.optInt("ownerUid", -1) != connect.uid) {
                throw VoiceClientFailure("Gateway returned the wrong Ship conversation")
            }
            shipConversationId = conversation.optString("id").takeIf(String::isNotBlank)
                ?: throw VoiceClientFailure("Ship conversation id was missing")
            shipHandlerPid = conversation.optString("handlerPid").takeIf(String::isNotBlank)
                ?: throw VoiceClientFailure("Ship handler was missing")
            ready.complete(connect)
            onReady(epoch)
        } catch (error: Throwable) {
            terminate(error)
        }
    }

    private fun handleSignal(json: JSONObject) {
        val conversationId = shipConversationId ?: return
        val handlerPid = shipHandlerPid ?: return
        val event = VoiceProtocol.parseTerminalSignal(json, conversationId, handlerPid) ?: return
        val runId = event.runId
        val terminalEvent = event.terminal
        val waiter = runWaiters.remove(runId)
        if (waiter != null) {
            waiter.complete(terminalEvent)
        } else {
            synchronized(terminalRunLock) { terminalRuns[runId] = terminalEvent }
        }
    }

    private fun handleBinary(bytes: ByteArray) {
        val frame = BinaryFrameCodec.decode(bytes) ?: run {
            terminate(VoiceClientFailure("Voice client received an invalid binary frame"))
            return
        }
        if (frame.flags and BinaryFrameCodec.CANCEL != 0) return
        val body = incomingBodies[frame.streamId] ?: return
        if (frame.flags and BinaryFrameCodec.ERROR != 0) {
            failIncomingBody(frame.streamId, VoiceClientFailure("Voice response body failed"))
            return
        }
        if (frame.flags and BinaryFrameCodec.DATA != 0 && frame.payload.isNotEmpty()) {
            if (body.output.size().toLong() + frame.payload.size > MAX_RESPONSE_BODY_BYTES) {
                sendBodyCancel(frame.streamId, "Voice response body is too large")
                failIncomingBody(frame.streamId, VoiceClientFailure("Voice response body is too large"))
                return
            }
            body.output.write(frame.payload)
        }
        if (frame.flags and BinaryFrameCodec.END != 0) {
            incomingBodies.remove(frame.streamId)
            val request = pending.remove(body.requestId) ?: return
            val result = body.output.toByteArray()
            if (body.expectedLength != null && result.size.toLong() != body.expectedLength) {
                request.deferred.completeExceptionally(VoiceClientFailure("Voice response body length did not match"))
            } else {
                request.deferred.complete(VoiceResponse(body.data, result))
            }
        }
    }

    private fun failIncomingBody(streamId: Long, error: Throwable) {
        val body = incomingBodies.remove(streamId) ?: return
        pending.remove(body.requestId)?.deferred?.completeExceptionally(error)
    }

    private fun sendBody(streamId: Long, bytes: ByteArray) {
        var offset = 0
        while (offset < bytes.size) {
            val end = minOf(bytes.size, offset + BODY_CHUNK_BYTES)
            val chunk = bytes.copyOfRange(offset, end)
            if (webSocket?.send(BinaryFrameCodec.encode(streamId, BinaryFrameCodec.DATA, chunk).toByteString()) != true) {
                throw VoiceClientFailure("Voice request body could not be sent")
            }
            offset = end
        }
        if (webSocket?.send(BinaryFrameCodec.encode(streamId, BinaryFrameCodec.END).toByteString()) != true) {
            throw VoiceClientFailure("Voice request body could not be completed")
        }
    }

    private fun sendBodyCancel(streamId: Long, reason: String) {
        webSocket?.send(
            BinaryFrameCodec.encode(
                streamId,
                BinaryFrameCodec.CANCEL or BinaryFrameCodec.END,
                reason.toByteArray(Charsets.UTF_8),
            ).toByteString(),
        )
    }

    private fun cancelPending(requestId: String) {
        val removed = pending.remove(requestId) ?: return
        incomingBodies.entries.firstOrNull { it.value.requestId == requestId }?.let { (streamId, _) ->
            incomingBodies.remove(streamId)
            sendBodyCancel(streamId, "Voice request cancelled")
        }
        removed.deferred.cancel()
        webSocket?.send(VoiceProtocol.requestCancelFrame(requestId))
    }

    private fun allocateStreamId(): Long {
        while (true) {
            val candidate = nextStreamId.getAndUpdate { current ->
                if (current >= BinaryFrameCodec.MAX_STREAM_ID) 1L else current + 1L
            }
            if (candidate != 0L) return candidate
        }
    }

    private fun terminate(error: Throwable) {
        if (!terminal.compareAndSet(false, true)) return
        handshakeTimeout?.cancel()
        if (!ready.isCompleted) ready.completeExceptionally(error)
        pending.values.forEach { it.deferred.completeExceptionally(error) }
        pending.clear()
        incomingBodies.clear()
        runWaiters.values.forEach { it.completeExceptionally(error) }
        runWaiters.clear()
        webSocket?.cancel()
        onTerminated(epoch, error)
    }

    private data class PendingRequest(
        val deferred: CompletableDeferred<VoiceResponse>,
    )

    private data class IncomingBody(
        val requestId: String,
        val data: JSONObject,
        val expectedLength: Long?,
        val output: ByteArrayOutputStream = ByteArrayOutputStream(),
    )

    companion object {
        private const val HANDSHAKE_TIMEOUT_MILLIS = 15_000L
        private const val DEFAULT_REQUEST_TIMEOUT_MILLIS = 30_000L
        private const val TRANSCRIPTION_TIMEOUT_MILLIS = 120_000L
        private const val SPEECH_TIMEOUT_MILLIS = 120_000L
        private const val RUN_TIMEOUT_MILLIS = 10 * 60_000L
        private const val BODY_CHUNK_BYTES = 64 * 1024
        private const val MAX_RESPONSE_BODY_BYTES = 24L * 1024 * 1024
        private const val MAX_CACHED_RUNS = 16
        private val REQUIRED_RUNTIME_CALLS = setOf(
            "conversation.ship",
            "conversation.send",
            "ai.transcription.create",
        )
        private val REQUIRED_RUNTIME_SIGNALS = setOf(
            "message.committed",
            "message.aborted",
            "proc.run.hil.requested",
            "proc.run.finished",
        )
    }
}
