package com.humansandmachines.gsv.wear.runtime

import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.camera.CapturedSnapshot
import com.humansandmachines.gsv.wear.camera.SnapshotCamera
import com.humansandmachines.gsv.wear.connection.DriverTransport
import com.humansandmachines.gsv.wear.protocol.BinaryFrame
import com.humansandmachines.gsv.wear.protocol.BinaryFrameCodec
import com.humansandmachines.gsv.wear.protocol.BodyDescriptor
import com.humansandmachines.gsv.wear.protocol.IncomingRequest
import com.humansandmachines.gsv.wear.target.AndroidTargetFileSystem
import com.humansandmachines.gsv.wear.target.WearTargetRuntimeFiles
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WearRequestDispatcherTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val temporaryRoots = mutableListOf<File>()

    @After
    fun tearDown() {
        scope.cancel()
        WearRuntimeState.reset()
        temporaryRoots.forEach(File::deleteRecursively)
    }

    @Test
    fun disarmedSnapshotFailsWithoutOpeningTheCamera() {
        val authority = WearAuthority { "generation" }
        val cameraCalls = AtomicInteger()
        val transport = FakeTransport()
        val dispatcher = createDispatcher(
            authority,
            SnapshotCamera {
                cameraCalls.incrementAndGet()
                error("Camera must remain closed")
            },
            transport,
        ).dispatcher

        dispatcher.onRequest(readRequest("req-1", WearVirtualFiles.CAMERA_SNAPSHOT))

        assertTrue(transport.response.await(2, TimeUnit.SECONDS))
        val data = JSONObject(transport.text.single()).getJSONObject("data")
        assertFalse(data.getBoolean("ok"))
        assertEquals("Wear Mode is not armed", data.getString("error"))
        assertEquals(0, cameraCalls.get())
    }

    @Test
    fun armedSnapshotStreamsAnExactImageBodyAndDeletesTheCapture() {
        val authority = WearAuthority { "generation" }.also { it.arm() }
        val expected = ByteArray(70_000) { index -> (index % 251).toByte() }
        val file = File.createTempFile("gsv-wear-test-", ".jpg").apply { writeBytes(expected) }
        val transport = FakeTransport()
        val dispatcher = createDispatcher(
            authority,
            SnapshotCamera { CapturedSnapshot(file) },
            transport,
        ).dispatcher

        dispatcher.onRequest(readRequest("req-2", WearVirtualFiles.CAMERA_SNAPSHOT))

        assertTrue(transport.bodyEnded.await(2, TimeUnit.SECONDS))
        val response = JSONObject(transport.text.single())
        assertEquals(expected.size.toLong(), response.getJSONObject("body").getLong("length"))
        val actual = transport.binary
            .filter { it.flags and BinaryFrameCodec.DATA != 0 }
            .flatMap { it.payload.asIterable() }
            .toByteArray()
        assertArrayEquals(expected, actual)
        assertTrue(waitUntil { !file.exists() })
    }

    @Test
    fun requestCancellationStopsCaptureWithoutALateResponse() {
        val authority = WearAuthority { "generation" }.also { it.arm() }
        val captureStarted = CountDownLatch(1)
        val captureCancelled = CountDownLatch(1)
        val transport = FakeTransport()
        val dispatcher = createDispatcher(
            authority,
            SnapshotCamera {
                suspendCancellableCoroutine { continuation ->
                    captureStarted.countDown()
                    continuation.invokeOnCancellation { captureCancelled.countDown() }
                }
            },
            transport,
        ).dispatcher

        dispatcher.onRequest(readRequest("req-3", WearVirtualFiles.CAMERA_SNAPSHOT))
        assertTrue(captureStarted.await(2, TimeUnit.SECONDS))
        dispatcher.onRequestCancel("req-3")

        assertTrue(captureCancelled.await(2, TimeUnit.SECONDS))
        assertFalse(transport.response.await(100, TimeUnit.MILLISECONDS))
        assertTrue(transport.text.isEmpty())
    }

    @Test
    fun responseBodyWaitsForWebSocketQueueCapacity() {
        val authority = WearAuthority { "generation" }.also { it.arm() }
        val expected = ByteArray(70_000) { index -> (index % 251).toByte() }
        val file = File.createTempFile("gsv-wear-backpressure-", ".jpg").apply { writeBytes(expected) }
        val transport = FakeTransport().apply { queued.set(5L * 1024 * 1024) }
        val dispatcher = createDispatcher(
            authority,
            SnapshotCamera { CapturedSnapshot(file) },
            transport,
        ).dispatcher

        dispatcher.onRequest(readRequest("req-backpressure", WearVirtualFiles.CAMERA_SNAPSHOT))

        assertTrue(transport.response.await(2, TimeUnit.SECONDS))
        assertFalse(transport.bodyEnded.await(100, TimeUnit.MILLISECONDS))
        transport.queued.set(0)
        assertTrue(transport.bodyEnded.await(2, TimeUnit.SECONDS))
        assertTrue(waitUntil { !file.exists() })
    }

    @Test
    fun transferReceiveConsumesAnExactRequestBodyAndCleansItsSpoolFile() = runBlocking {
        val authority = WearAuthority { "generation" }
        val transport = FakeTransport()
        val fixture = createDispatcher(
            authority,
            SnapshotCamera { error("Camera must remain closed") },
            transport,
        )
        val expected = ByteArray(80_000) { index -> (index % 239).toByte() }

        fixture.dispatcher.onRequest(
            IncomingRequest(
                id = "req-transfer",
                call = "fs.transfer.receive",
                args = JSONObject()
                    .put("path", "/home/android/incoming.bin")
                    .put("contentType", "application/octet-stream"),
                body = BodyDescriptor(41, expected.size.toLong()),
            ),
        )
        fixture.dispatcher.onBinary(
            BinaryFrameCodec.encode(41, BinaryFrameCodec.DATA, expected.copyOfRange(0, 65_000)),
        )
        fixture.dispatcher.onBinary(
            BinaryFrameCodec.encode(41, BinaryFrameCodec.DATA, expected.copyOfRange(65_000, expected.size)),
        )
        fixture.dispatcher.onBinary(BinaryFrameCodec.encode(41, BinaryFrameCodec.END))

        assertTrue(transport.response.await(2, TimeUnit.SECONDS))
        val data = JSONObject(transport.text.single()).getJSONObject("data")
        assertTrue(data.getBoolean("ok"))
        assertEquals(expected.size.toLong(), data.getLong("bytesWritten"))
        val actual = fixture.fileSystem.open("/home/android/incoming.bin").use { handle ->
            handle.open().use { it.readBytes() }
        }
        assertArrayEquals(expected, actual)
        assertTrue(waitUntil { fixture.incomingDirectory.listFiles().isNullOrEmpty() })
    }

    @Test
    fun shellExecRunsAgainstTheSameVirtualFilesystem() {
        val authority = WearAuthority { "generation" }
        val transport = FakeTransport()
        val fixture = createDispatcher(
            authority,
            SnapshotCamera { error("Camera must remain closed") },
            transport,
        )

        fixture.dispatcher.onRequest(
            IncomingRequest(
                id = "req-shell",
                call = "shell.exec",
                args = JSONObject().put("input", "echo hello > note.txt; cat note.txt"),
                body = null,
            ),
        )

        assertTrue(transport.response.await(2, TimeUnit.SECONDS))
        val data = JSONObject(transport.text.single()).getJSONObject("data")
        assertEquals("completed", data.getString("status"))
        assertEquals("hello\n", data.getString("output"))
    }

    @Test
    fun cameraCommandMaterializesOneArmedCaptureAsAnOrdinaryFile() = runBlocking {
        val authority = WearAuthority { "generation" }.also { it.arm() }
        val expected = ByteArray(2_048) { index -> (index % 241).toByte() }
        val capture = File.createTempFile("gsv-wear-command-", ".jpg").apply { writeBytes(expected) }
        val transport = FakeTransport()
        val fixture = createDispatcher(
            authority,
            SnapshotCamera { CapturedSnapshot(capture) },
            transport,
        )

        fixture.dispatcher.onRequest(
            IncomingRequest(
                id = "req-camera-command",
                call = "shell.exec",
                args = JSONObject().put("input", "camera snapshot /tmp/context.jpg"),
                body = null,
            ),
        )

        assertTrue(transport.response.await(2, TimeUnit.SECONDS))
        val data = JSONObject(transport.text.single()).getJSONObject("data")
        assertEquals("completed", data.getString("status"))
        val output = JSONObject(data.getString("output"))
        assertEquals("/tmp/context.jpg", output.getString("path"))
        val actual = fixture.fileSystem.open("/tmp/context.jpg").use { handle ->
            handle.open().use { it.readBytes() }
        }
        assertArrayEquals(expected, actual)
        assertTrue(waitUntil { !capture.exists() })
    }

    @Test
    fun transferLengthMismatchFailsWithoutPublishingAPartialFile() {
        val authority = WearAuthority { "generation" }
        val transport = FakeTransport()
        val fixture = createDispatcher(
            authority,
            SnapshotCamera { error("Camera must remain closed") },
            transport,
        )

        fixture.dispatcher.onRequest(
            IncomingRequest(
                id = "req-short-transfer",
                call = "fs.transfer.receive",
                args = JSONObject().put("path", "/home/android/partial.bin"),
                body = BodyDescriptor(42, 10),
            ),
        )
        fixture.dispatcher.onBinary(
            BinaryFrameCodec.encode(42, BinaryFrameCodec.DATA, byteArrayOf(1, 2, 3)),
        )
        fixture.dispatcher.onBinary(BinaryFrameCodec.encode(42, BinaryFrameCodec.END))

        assertTrue(transport.response.await(2, TimeUnit.SECONDS))
        val data = JSONObject(transport.text.single()).getJSONObject("data")
        assertFalse(data.getBoolean("ok"))
        assertTrue(data.getString("error").contains("did not match"))
        assertTrue(
            transport.binary.any {
                it.streamId == 42L && it.flags and BinaryFrameCodec.CANCEL != 0
            },
        )
        assertTrue(waitUntil { fixture.incomingDirectory.listFiles().isNullOrEmpty() })
        val destinationExists = runBlocking {
            try {
                fixture.fileSystem.stat("/home/android/partial.bin")
                true
            } catch (_: Exception) {
                false
            }
        }
        assertFalse(destinationExists)
    }

    private fun readRequest(id: String, path: String): IncomingRequest = IncomingRequest(
        id = id,
        call = "fs.read",
        args = JSONObject().put("path", path),
        body = null,
    )

    private fun createDispatcher(
        authority: WearAuthority,
        camera: SnapshotCamera,
        transport: FakeTransport,
    ): Fixture {
        val root = Files.createTempDirectory("gsv-android-dispatcher-").toFile().also(temporaryRoots::add)
        val runtime = WearTargetRuntimeFiles(
            authority = authority,
            camera = camera,
            deviceInfo = {
                JSONObject()
                    .put("platform", "android")
                    .put("supportedAbis", JSONArray())
            },
        )
        val fileSystem = AndroidTargetFileSystem(
            persistentRoot = File(root, "home"),
            temporaryRoot = File(root, "tmp"),
            runtime = runtime,
        )
        val incoming = File(root, "incoming")
        val dispatcher = WearRequestDispatcherFactory(
            parentScope = scope,
            fileSystem = fileSystem,
            incomingDirectory = incoming,
        ).create(transport)
        return Fixture(dispatcher, fileSystem, incoming)
    }

    private fun waitUntil(condition: () -> Boolean): Boolean {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
        while (System.nanoTime() < deadline) {
            if (condition()) return true
            Thread.sleep(5)
        }
        return condition()
    }

    private class FakeTransport : DriverTransport {
        override val epoch = 1L
        val text = CopyOnWriteArrayList<String>()
        val binary = CopyOnWriteArrayList<BinaryFrame>()
        val response = CountDownLatch(1)
        val bodyEnded = CountDownLatch(1)
        val queued = AtomicLong()

        override fun sendText(text: String): Boolean {
            this.text += text
            response.countDown()
            return true
        }

        override fun sendBinary(bytes: ByteArray): Boolean {
            val frame = BinaryFrameCodec.decode(bytes) ?: return false
            binary += frame
            if (frame.flags and BinaryFrameCodec.END != 0) bodyEnded.countDown()
            return true
        }

        override fun queuedBytes(): Long = queued.get()
    }

    private data class Fixture(
        val dispatcher: com.humansandmachines.gsv.wear.connection.DriverRequestDispatcher,
        val fileSystem: AndroidTargetFileSystem,
        val incomingDirectory: File,
    )
}
