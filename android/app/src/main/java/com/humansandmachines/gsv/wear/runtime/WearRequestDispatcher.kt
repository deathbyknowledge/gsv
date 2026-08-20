package com.humansandmachines.gsv.wear.runtime

import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.camera.CameraCaptureFailure
import com.humansandmachines.gsv.wear.camera.CapturedSnapshot
import com.humansandmachines.gsv.wear.camera.SnapshotCamera
import com.humansandmachines.gsv.wear.connection.DriverRequestDispatcher
import com.humansandmachines.gsv.wear.connection.DriverRequestDispatcherFactory
import com.humansandmachines.gsv.wear.connection.DriverTransport
import com.humansandmachines.gsv.wear.protocol.BinaryFrameCodec
import com.humansandmachines.gsv.wear.protocol.BodyDescriptor
import com.humansandmachines.gsv.wear.protocol.GsvProtocol
import com.humansandmachines.gsv.wear.protocol.IncomingRequest
import java.io.ByteArrayInputStream
import java.io.FileInputStream
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

class WearRequestDispatcherFactory(
    private val parentScope: CoroutineScope,
    private val authority: WearAuthority,
    private val camera: SnapshotCamera,
) : DriverRequestDispatcherFactory {
    private val dispatchers = ConcurrentHashMap<Long, WearRequestDispatcher>()

    override fun create(transport: DriverTransport): DriverRequestDispatcher {
        lateinit var dispatcher: WearRequestDispatcher
        dispatcher = WearRequestDispatcher(
            transport = transport,
            parentScope = parentScope,
            authority = authority,
            camera = camera,
            onClosed = { dispatchers.remove(transport.epoch, dispatcher) },
        )
        dispatchers[transport.epoch] = dispatcher
        return dispatcher
    }

    fun cancelAll() {
        dispatchers.values.forEach(WearRequestDispatcher::cancelAll)
    }
}

private class WearRequestDispatcher(
    private val transport: DriverTransport,
    parentScope: CoroutineScope,
    private val authority: WearAuthority,
    private val camera: SnapshotCamera,
    private val onClosed: () -> Unit,
) : DriverRequestDispatcher {
    private val scope = CoroutineScope(
        parentScope.coroutineContext + SupervisorJob(parentScope.coroutineContext[Job]),
    )
    private val activeRequests = ConcurrentHashMap<String, Job>()
    private val outgoingBodies = ConcurrentHashMap<Long, OutgoingBody>()
    private val nextStreamId = AtomicLong(1)
    private val closed = AtomicBoolean(false)

    override fun onRequest(request: IncomingRequest) {
        if (closed.get()) return
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                handleRequest(request)
            } finally {
                activeRequests.remove(request.id, currentCoroutineContext().job)
            }
        }
        if (activeRequests.putIfAbsent(request.id, job) == null) {
            job.start()
        } else {
            job.cancel()
        }
    }

    override fun onRequestCancel(id: String) {
        activeRequests[id]?.cancel(CancellationException("Request cancelled"))
    }

    override fun onBinary(bytes: ByteArray) {
        val frame = BinaryFrameCodec.decode(bytes) ?: return
        if (frame.flags and (BinaryFrameCodec.CANCEL or BinaryFrameCodec.ERROR) == 0) return
        outgoingBodies[frame.streamId]?.cancelFromPeer()
    }

    fun cancelAll() {
        activeRequests.values.forEach { it.cancel(CancellationException("Wear authority changed")) }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        cancelAll()
        scope.cancel(CancellationException("Driver connection closed"))
        onClosed()
    }

    private suspend fun handleRequest(request: IncomingRequest) {
        val responder = RequestResponder(request.id, transport)
        try {
            if (request.body != null) {
                cancelIncomingBody(request.body)
                responder.error("Android fs.read does not accept a request body")
                return
            }
            if (request.call != "fs.read") {
                responder.protocolError("Unsupported Android driver syscall")
                return
            }
            if (request.args.has("offset") || request.args.has("limit")) {
                responder.error("Virtual wearable files do not support offset or limit")
                return
            }
            when (request.args.optString("path")) {
                WearVirtualFiles.STATUS -> sendStatus(responder)
                WearVirtualFiles.CAMERA_SNAPSHOT -> sendSnapshot(responder)
                else -> responder.error("Virtual wearable path not found")
            }
        } catch (error: CameraCaptureFailure) {
            responder.error(error.message ?: "Camera capture failed")
        } catch (_: CancellationException) {
            // Cancellation owns cleanup and intentionally suppresses late responses.
        } catch (_: Exception) {
            responder.error("Wear request failed")
        }
    }

    private suspend fun sendStatus(responder: RequestResponder) {
        val snapshot = WearRuntimeState.snapshot.value
        val text = JSONObject()
            .put("wearAuthority", snapshot.authority.name.lowercase())
            .put("connection", snapshot.connection.name.lowercase())
            .put("camera", snapshot.camera.name.lowercase())
            .put("microphone", "closed")
            .put(
                "capabilities",
                JSONObject().put(
                    "camera.snapshot",
                    JSONObject()
                        .put("authorized", snapshot.authority == AuthorityState.ARMED)
                        .put("path", WearVirtualFiles.CAMERA_SNAPSHOT)
                        .put("timeoutMs", 5_000),
                ),
            )
            .put("rawMediaRetained", false)
            .toString(2) + "\n"
        val bytes = text.toByteArray(Charsets.UTF_8)
        val data = JSONObject()
            .put("ok", true)
            .put("path", WearVirtualFiles.STATUS)
            .put("kind", "text")
            .put("contentType", "application/json; charset=utf-8")
            .put("lines", text.count { it == '\n' })
            .put("size", bytes.size)
        sendBody(responder, data, OwnedBody.fromBytes(bytes))
    }

    private suspend fun sendSnapshot(responder: RequestResponder) {
        val lease = authority.acquire() ?: run {
            responder.error(
                if (authority.state() == AuthorityState.PAUSED) {
                    "Wear Mode is paused"
                } else {
                    "Wear Mode is not armed"
                },
            )
            return
        }
        val snapshot = camera.capture(lease)
        if (!authority.isCurrent(lease)) {
            snapshot.close()
            throw CameraCaptureFailure("Wear Mode authority changed during capture")
        }
        currentCoroutineContext().ensureActive()
        val data = JSONObject()
            .put("ok", true)
            .put("path", WearVirtualFiles.CAMERA_SNAPSHOT)
            .put("kind", "image")
            .put("contentType", "image/jpeg")
            .put("size", snapshot.length)
        sendBody(responder, data, OwnedBody.fromSnapshot(snapshot))
    }

    private suspend fun sendBody(
        responder: RequestResponder,
        data: JSONObject,
        body: OwnedBody,
    ) {
        currentCoroutineContext().ensureActive()
        val streamId = allocateStreamId()
        val currentJob = currentCoroutineContext().job
        val outgoing = OutgoingBody(currentJob)
        outgoingBodies[streamId] = outgoing
        try {
            if (!responder.body(data, BodyDescriptor(streamId, body.length))) return
            withContext(Dispatchers.IO) {
                body.open().use { input -> sendChunks(streamId, input) }
            }
            currentCoroutineContext().ensureActive()
            if (!transport.sendBinary(BinaryFrameCodec.encode(streamId, BinaryFrameCodec.END))) {
                throw IllegalStateException("Driver connection closed")
            }
        } catch (error: CancellationException) {
            if (!outgoing.peerCancelled.get()) sendBodyError(streamId)
            throw error
        } catch (error: Exception) {
            if (!outgoing.peerCancelled.get()) sendBodyError(streamId)
            throw error
        } finally {
            outgoingBodies.remove(streamId, outgoing)
            body.close()
        }
    }

    private suspend fun sendChunks(streamId: Long, input: InputStream) {
        val buffer = ByteArray(BODY_CHUNK_BYTES)
        while (true) {
            currentCoroutineContext().ensureActive()
            val count = input.read(buffer)
            if (count < 0) return
            if (count == 0) continue
            val payload = if (count == buffer.size) buffer else buffer.copyOf(count)
            if (!transport.sendBinary(BinaryFrameCodec.encode(streamId, BinaryFrameCodec.DATA, payload))) {
                throw IllegalStateException("Driver connection closed")
            }
        }
    }

    private fun cancelIncomingBody(body: BodyDescriptor) {
        transport.sendBinary(
            BinaryFrameCodec.encode(
                body.streamId,
                BinaryFrameCodec.CANCEL or BinaryFrameCodec.END,
                "Request body is unsupported".toByteArray(Charsets.UTF_8),
            ),
        )
    }

    private fun sendBodyError(streamId: Long) {
        transport.sendBinary(
            BinaryFrameCodec.encode(
                streamId,
                BinaryFrameCodec.ERROR or BinaryFrameCodec.END,
                "Binary transfer cancelled".toByteArray(Charsets.UTF_8),
            ),
        )
    }

    private fun allocateStreamId(): Long {
        while (true) {
            val candidate = nextStreamId.getAndUpdate {
                if (it == BinaryFrameCodec.MAX_STREAM_ID) 1L else it + 1
            }
            if (!outgoingBodies.containsKey(candidate)) return candidate
        }
    }

    private class OutgoingBody(val job: Job) {
        val peerCancelled = AtomicBoolean(false)

        fun cancelFromPeer() {
            peerCancelled.set(true)
            job.cancel(CancellationException("Peer cancelled binary body"))
        }
    }

    private class RequestResponder(
        private val id: String,
        private val transport: DriverTransport,
    ) {
        private val committed = AtomicBoolean(false)

        fun error(message: String) {
            if (!committed.compareAndSet(false, true)) return
            transport.sendText(
                GsvProtocol.successfulResponse(
                    id,
                    JSONObject().put("ok", false).put("error", message),
                ),
            )
        }

        fun protocolError(message: String) {
            if (!committed.compareAndSet(false, true)) return
            transport.sendText(GsvProtocol.errorResponse(id, 400, message))
        }

        fun body(data: JSONObject, descriptor: BodyDescriptor): Boolean {
            if (!committed.compareAndSet(false, true)) return false
            return transport.sendText(GsvProtocol.successfulResponse(id, data, descriptor))
        }
    }

    private class OwnedBody(
        val length: Long,
        val open: () -> InputStream,
        private val cleanup: () -> Unit,
    ) {
        fun close() = cleanup()

        companion object {
            fun fromBytes(bytes: ByteArray): OwnedBody = OwnedBody(
                length = bytes.size.toLong(),
                open = { ByteArrayInputStream(bytes) },
                cleanup = {},
            )

            fun fromSnapshot(snapshot: CapturedSnapshot): OwnedBody = OwnedBody(
                length = snapshot.length,
                open = { FileInputStream(snapshot.file) },
                cleanup = snapshot::close,
            )
        }
    }

    companion object {
        private const val BODY_CHUNK_BYTES = 64 * 1024
    }
}

object WearVirtualFiles {
    const val STATUS = "/dev/wear/status"
    const val CAMERA_SNAPSHOT = "/dev/camera/back/snapshot"
}
