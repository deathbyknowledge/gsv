package com.humansandmachines.gsv.wear.runtime

import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.camera.CapturedSnapshot
import com.humansandmachines.gsv.wear.camera.SnapshotCamera
import com.humansandmachines.gsv.wear.connection.DriverTransport
import com.humansandmachines.gsv.wear.protocol.BinaryFrame
import com.humansandmachines.gsv.wear.protocol.BinaryFrameCodec
import com.humansandmachines.gsv.wear.protocol.IncomingRequest
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WearRequestDispatcherTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After
    fun tearDown() {
        scope.cancel()
        WearRuntimeState.reset()
    }

    @Test
    fun disarmedSnapshotFailsWithoutOpeningTheCamera() {
        val authority = WearAuthority { "generation" }
        val cameraCalls = AtomicInteger()
        val transport = FakeTransport()
        val dispatcher = WearRequestDispatcherFactory(
            scope,
            authority,
            SnapshotCamera {
                cameraCalls.incrementAndGet()
                error("Camera must remain closed")
            },
        ).create(transport)

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
        val dispatcher = WearRequestDispatcherFactory(
            scope,
            authority,
            SnapshotCamera { CapturedSnapshot(file) },
        ).create(transport)

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
        val dispatcher = WearRequestDispatcherFactory(
            scope,
            authority,
            SnapshotCamera {
                suspendCancellableCoroutine { continuation ->
                    captureStarted.countDown()
                    continuation.invokeOnCancellation { captureCancelled.countDown() }
                }
            },
        ).create(transport)

        dispatcher.onRequest(readRequest("req-3", WearVirtualFiles.CAMERA_SNAPSHOT))
        assertTrue(captureStarted.await(2, TimeUnit.SECONDS))
        dispatcher.onRequestCancel("req-3")

        assertTrue(captureCancelled.await(2, TimeUnit.SECONDS))
        assertFalse(transport.response.await(100, TimeUnit.MILLISECONDS))
        assertTrue(transport.text.isEmpty())
    }

    private fun readRequest(id: String, path: String): IncomingRequest = IncomingRequest(
        id = id,
        call = "fs.read",
        args = JSONObject().put("path", path),
        body = null,
    )

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
    }
}
