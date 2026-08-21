package com.humansandmachines.gsv.wear.runtime

import com.humansandmachines.gsv.wear.camera.CameraCaptureFailure
import com.humansandmachines.gsv.wear.connection.DriverRequestDispatcher
import com.humansandmachines.gsv.wear.connection.DriverRequestDispatcherFactory
import com.humansandmachines.gsv.wear.connection.DriverTransport
import com.humansandmachines.gsv.wear.protocol.BinaryFrame
import com.humansandmachines.gsv.wear.protocol.BinaryFrameCodec
import com.humansandmachines.gsv.wear.protocol.BodyDescriptor
import com.humansandmachines.gsv.wear.protocol.GsvProtocol
import com.humansandmachines.gsv.wear.protocol.IncomingRequest
import com.humansandmachines.gsv.wear.target.AndroidTargetFileSystem
import com.humansandmachines.gsv.wear.target.TargetFileSystem
import com.humansandmachines.gsv.wear.target.TargetFsException
import com.humansandmachines.gsv.wear.target.TargetFsHandler
import com.humansandmachines.gsv.wear.target.TargetHandlerResponse
import com.humansandmachines.gsv.wear.target.TargetNetHandler
import com.humansandmachines.gsv.wear.target.TargetReadHandle
import com.humansandmachines.gsv.wear.target.TargetRequestBody
import com.humansandmachines.gsv.wear.target.TargetShell
import com.humansandmachines.gsv.wear.target.WearTargetRuntimeFiles
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

class WearRequestDispatcherFactory(
    private val parentScope: CoroutineScope,
    fileSystem: TargetFileSystem,
    private val incomingDirectory: File,
    private val shell: TargetShell = TargetShell(fileSystem),
    private val netHandler: TargetNetHandler = TargetNetHandler(File(incomingDirectory, "net")),
) : DriverRequestDispatcherFactory {
    private val fsHandler = TargetFsHandler(fileSystem)
    private val dispatchers = ConcurrentHashMap<Long, WearRequestDispatcher>()

    override fun create(transport: DriverTransport): DriverRequestDispatcher {
        lateinit var dispatcher: WearRequestDispatcher
        dispatcher = WearRequestDispatcher(
            transport = transport,
            parentScope = parentScope,
            fsHandler = fsHandler,
            shell = shell,
            netHandler = netHandler,
            incomingDirectory = incomingDirectory,
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
    private val fsHandler: TargetFsHandler,
    private val shell: TargetShell,
    private val netHandler: TargetNetHandler,
    private val incomingDirectory: File,
    private val onClosed: () -> Unit,
) : DriverRequestDispatcher {
    private val scope = CoroutineScope(
        parentScope.coroutineContext + SupervisorJob(parentScope.coroutineContext[Job]),
    )
    private val activeRequests = ConcurrentHashMap<String, Job>()
    private val requestBodies = ConcurrentHashMap<String, IncomingRequestBody>()
    private val incomingBodies = ConcurrentHashMap<Long, IncomingRequestBody>()
    private val outgoingBodies = ConcurrentHashMap<Long, OutgoingBody>()
    private val nextStreamId = AtomicLong(1)
    private val closed = AtomicBoolean(false)

    override fun onRequest(request: IncomingRequest) {
        if (closed.get()) return
        if (activeRequests.containsKey(request.id)) {
            request.body?.let { cancelBodyDescriptor(it, "Duplicate request id") }
            return
        }
        if (activeRequests.size >= MAX_ACTIVE_REQUESTS) {
            request.body?.let { cancelBodyDescriptor(it, "Android target is busy") }
            transport.sendText(GsvProtocol.errorResponse(request.id, 429, "Android target is busy"))
            return
        }

        val requestBody = request.body?.let { descriptor ->
            val reservedBytes = descriptor.length ?: AndroidTargetFileSystem.MAX_TARGET_FILE_BYTES
            val currentReservedBytes = incomingBodies.values.sumOf(IncomingRequestBody::reservedBytes)
            if (
                incomingBodies.size >= MAX_ACTIVE_INCOMING_BODIES ||
                currentReservedBytes + reservedBytes > MAX_INCOMING_SPOOL_BYTES
            ) {
                rejectBeforeDispatch(request, descriptor, "Too many active request bodies")
                return
            }
            val body = try {
                IncomingRequestBody(descriptor, incomingDirectory, transport)
            } catch (error: Exception) {
                rejectBeforeDispatch(request, descriptor, error.message ?: "Unable to receive request body")
                return
            }
            if (incomingBodies.putIfAbsent(descriptor.streamId, body) != null) {
                body.cancel("Binary request stream is already pending")
                body.close()
                transport.sendText(
                    GsvProtocol.successfulResponse(
                        request.id,
                        JSONObject().put("ok", false).put("error", "Binary request stream is already pending"),
                    ),
                )
                return
            }
            requestBodies[request.id] = body
            body
        }

        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                handleRequest(request, requestBody)
            } finally {
                requestBody?.let { body ->
                    requestBodies.remove(request.id, body)
                    incomingBodies.remove(body.streamId, body)
                    body.close()
                }
                activeRequests.remove(request.id, currentCoroutineContext().job)
            }
        }
        if (activeRequests.putIfAbsent(request.id, job) == null) {
            job.start()
        } else {
            requestBody?.cancel("Duplicate request id")
            requestBody?.close()
            job.cancel()
        }
    }

    override fun onRequestCancel(id: String) {
        activeRequests[id]?.cancel(CancellationException("Request cancelled"))
        requestBodies[id]?.cancel("Request cancelled")
    }

    override fun onBinary(bytes: ByteArray) {
        val frame = BinaryFrameCodec.decode(bytes) ?: return
        if (frame.flags and BinaryFrameCodec.CANCEL != 0) {
            outgoingBodies[frame.streamId]?.let { outgoing ->
                outgoing.cancelFromPeer()
                return
            }
        }
        incomingBodies[frame.streamId]?.accept(frame)
    }

    fun cancelAll() {
        activeRequests.values.forEach { it.cancel(CancellationException("Wear runtime changed")) }
        requestBodies.values.forEach { it.cancel("Wear runtime changed") }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        cancelAll()
        incomingBodies.values.forEach(IncomingRequestBody::close)
        scope.cancel(CancellationException("Driver connection closed"))
        onClosed()
    }

    private suspend fun handleRequest(request: IncomingRequest, body: TargetRequestBody?) {
        val responder = RequestResponder(request.id, transport)
        try {
            val response = when {
                request.call in FS_CALLS -> fsHandler.handle(request.call, request.args, body)
                request.call == "shell.exec" -> {
                    if (body != null) {
                        body.cancel("shell.exec does not accept a request body")
                        TargetHandlerResponse.Data(
                            JSONObject()
                                .put("status", "failed")
                                .put("output", "")
                                .put("error", "shell.exec does not accept a request body"),
                        )
                    } else {
                        TargetHandlerResponse.Data(shell.execute(request.args))
                    }
                }
                request.call == "net.fetch" -> netHandler.handle(request.args, body)
                else -> {
                    body?.cancel("Unsupported Android driver syscall")
                    responder.protocolError("Unsupported Android driver syscall: ${request.call}")
                    return
                }
            }
            when (response) {
                is TargetHandlerResponse.Data -> responder.data(response.data)
                is TargetHandlerResponse.Body -> sendBody(responder, response.data, response.body)
            }
        } catch (error: CameraCaptureFailure) {
            responder.data(failure(error.message ?: "Camera capture failed"))
        } catch (error: TargetFsException) {
            responder.data(failure(error.message ?: "Android target operation failed"))
        } catch (_: CancellationException) {
            // Cancellation owns cleanup and intentionally suppresses late responses.
        } catch (_: Exception) {
            responder.data(failure("Android target request failed"))
        }
    }

    private suspend fun sendBody(
        responder: RequestResponder,
        data: JSONObject,
        body: TargetReadHandle,
    ) {
        currentCoroutineContext().ensureActive()
        val streamId = allocateStreamId()
        val currentJob = currentCoroutineContext().job
        val outgoing = OutgoingBody(currentJob)
        outgoingBodies[streamId] = outgoing
        try {
            if (!responder.body(data, BodyDescriptor(streamId, body.length))) return
            val sent = withContext(Dispatchers.IO) {
                body.open().use { input -> sendChunks(streamId, input) }
            }
            if (sent != body.length) {
                throw TargetFsException("Body length $sent did not match ${body.length}")
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

    private suspend fun sendChunks(streamId: Long, input: InputStream): Long {
        val buffer = ByteArray(BODY_CHUNK_BYTES)
        var sent = 0L
        while (true) {
            currentCoroutineContext().ensureActive()
            val count = input.read(buffer)
            if (count < 0) return sent
            if (count == 0) continue
            sent += count
            val payload = if (count == buffer.size) buffer else buffer.copyOf(count)
            while (transport.queuedBytes() > MAX_OUTBOUND_QUEUE_BYTES) {
                currentCoroutineContext().ensureActive()
                delay(OUTBOUND_QUEUE_POLL_MS)
            }
            if (!transport.sendBinary(BinaryFrameCodec.encode(streamId, BinaryFrameCodec.DATA, payload))) {
                throw IllegalStateException("Driver connection closed")
            }
        }
    }

    private fun rejectBeforeDispatch(request: IncomingRequest, body: BodyDescriptor, message: String) {
        cancelBodyDescriptor(body, message)
        transport.sendText(
            GsvProtocol.successfulResponse(
                request.id,
                JSONObject().put("ok", false).put("error", message),
            ),
        )
    }

    private fun cancelBodyDescriptor(body: BodyDescriptor, reason: String) {
        transport.sendBinary(
            BinaryFrameCodec.encode(
                body.streamId,
                BinaryFrameCodec.CANCEL or BinaryFrameCodec.END,
                reason.toByteArray(Charsets.UTF_8),
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
            if (!outgoingBodies.containsKey(candidate) && !incomingBodies.containsKey(candidate)) return candidate
        }
    }

    private fun failure(message: String): JSONObject = JSONObject()
        .put("ok", false)
        .put("error", message)

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

        fun data(data: JSONObject) {
            if (!committed.compareAndSet(false, true)) return
            transport.sendText(GsvProtocol.successfulResponse(id, data))
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

    companion object {
        private const val BODY_CHUNK_BYTES = 64 * 1024
        private const val MAX_OUTBOUND_QUEUE_BYTES = 4L * 1024 * 1024
        private const val OUTBOUND_QUEUE_POLL_MS = 10L
        private const val MAX_ACTIVE_REQUESTS = 32
        private const val MAX_ACTIVE_INCOMING_BODIES = 8
        private const val MAX_INCOMING_SPOOL_BYTES = 128L * 1024 * 1024
        private val FS_CALLS = setOf(
            "fs.read",
            "fs.write",
            "fs.edit",
            "fs.delete",
            "fs.search",
            "fs.copy",
            "fs.transfer.stat",
            "fs.transfer.send",
            "fs.transfer.receive",
        )
    }
}

private class IncomingRequestBody(
    descriptor: BodyDescriptor,
    directory: File,
    private val transport: DriverTransport,
) : TargetRequestBody {
    override val length: Long? = descriptor.length
    val streamId: Long = descriptor.streamId
    val reservedBytes: Long = length ?: AndroidTargetFileSystem.MAX_TARGET_FILE_BYTES

    private val lock = Any()
    private val completed = CompletableDeferred<Unit>()
    private val file: File
    private val output: FileOutputStream
    private var received = 0L
    private var terminal = false
    private var closed = false

    init {
        if (length != null && length > AndroidTargetFileSystem.MAX_TARGET_FILE_BYTES) {
            throw TargetFsException(
                "Request body exceeds ${AndroidTargetFileSystem.MAX_TARGET_FILE_BYTES} bytes",
            )
        }
        if (!directory.mkdirs() && !directory.isDirectory) {
            throw TargetFsException("Unable to create incoming transfer directory")
        }
        file = File.createTempFile("gsv-body-", ".tmp", directory)
        output = FileOutputStream(file)
    }

    fun accept(frame: BinaryFrame) {
        var notifyReason: String? = null
        try {
            synchronized(lock) {
                if (terminal || closed) return
                if (frame.flags and (BinaryFrameCodec.ERROR or BinaryFrameCodec.CANCEL) != 0) {
                    val message = frame.payload.toString(Charsets.UTF_8).take(MAX_ERROR_CHARS)
                        .ifBlank { "Binary request body was cancelled by sender" }
                    failLocked(message)
                    return
                }
                if (frame.flags and BinaryFrameCodec.DATA != 0 && frame.payload.isNotEmpty()) {
                    val next = received + frame.payload.size
                    val maximum = length ?: AndroidTargetFileSystem.MAX_TARGET_FILE_BYTES
                    if (next > maximum || next > AndroidTargetFileSystem.MAX_TARGET_FILE_BYTES) {
                        notifyReason = "Body exceeded declared or maximum length"
                        failLocked(notifyReason!!)
                    } else {
                        output.write(frame.payload)
                        received = next
                    }
                }
                if (!terminal && frame.flags and BinaryFrameCodec.END != 0) {
                    if (length != null && received != length) {
                        notifyReason = "Body length $received did not match $length"
                        failLocked(notifyReason!!)
                    } else {
                        output.close()
                        terminal = true
                        completed.complete(Unit)
                    }
                }
            }
        } catch (_: Exception) {
            notifyReason = "Unable to spool binary request body"
            synchronized(lock) {
                if (!terminal && !closed) failLocked(notifyReason!!)
            }
        }
        notifyReason?.let(::sendCancel)
    }

    override suspend fun open(): InputStream {
        try {
            withTimeout(BODY_IDLE_TIMEOUT_MS) { completed.await() }
        } catch (_: TimeoutCancellationException) {
            cancel("Binary request body timed out")
            throw TargetFsException("Binary request body timed out")
        }
        synchronized(lock) {
            if (closed) throw TargetFsException("Binary request body is closed")
        }
        return FileInputStream(file)
    }

    override fun cancel(reason: String) {
        val notify = synchronized(lock) {
            if (terminal || closed) {
                false
            } else {
                failLocked(reason)
                true
            }
        }
        if (notify) sendCancel(reason)
    }

    override fun close() {
        cancel("Binary request body closed")
        synchronized(lock) { closed = true }
        file.delete()
    }

    private fun failLocked(message: String) {
        runCatching { output.close() }
        terminal = true
        completed.completeExceptionally(TargetFsException(message))
    }

    private fun sendCancel(reason: String) {
        transport.sendBinary(
            BinaryFrameCodec.encode(
                streamId,
                BinaryFrameCodec.CANCEL or BinaryFrameCodec.END,
                reason.take(MAX_ERROR_CHARS).toByteArray(Charsets.UTF_8),
            ),
        )
    }

    companion object {
        private const val BODY_IDLE_TIMEOUT_MS = 120_000L
        private const val MAX_ERROR_CHARS = 512
    }
}

object WearVirtualFiles {
    const val STATUS = WearTargetRuntimeFiles.STATUS
    const val CAMERA_SNAPSHOT = WearTargetRuntimeFiles.CAMERA_SNAPSHOT
}
