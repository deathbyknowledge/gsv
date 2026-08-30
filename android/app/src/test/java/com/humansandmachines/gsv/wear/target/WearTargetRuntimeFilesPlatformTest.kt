package com.humansandmachines.gsv.wear.target

import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.camera.SnapshotCamera
import com.humansandmachines.gsv.wear.platform.GsvDisplaySize
import com.humansandmachines.gsv.wear.platform.GsvForegroundActivity
import com.humansandmachines.gsv.wear.platform.GsvPlatformCapture
import com.humansandmachines.gsv.wear.platform.GsvPlatformOperations
import com.humansandmachines.gsv.wear.platform.GsvPlatformStatus
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WearTargetRuntimeFilesPlatformTest {
    @Test
    fun screenshotNodeOwnsCaptureUntilResponseCloses() = runBlocking {
        val root = Files.createTempDirectory("gsv-screen-runtime-").toFile()
        try {
            val authority = WearAuthority { "lease" }.also(WearAuthority::arm)
            val platform = FakePlatform(root)
            val runtime = WearTargetRuntimeFiles(
                authority = authority,
                camera = SnapshotCamera { error("Camera must not be used") },
                deviceInfo = { JSONObject() },
                platform = platform,
            )

            val handle = checkNotNull(runtime.open(WearTargetRuntimeFiles.SCREEN_SCREENSHOT))
            val captureFile = checkNotNull(platform.captureFile)
            assertTrue(captureFile.exists())
            assertArrayEquals(PNG_BYTES, handle.open().use { it.readBytes() })

            handle.close()

            assertFalse(captureFile.exists())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun screenshotNodeDoesNotReachPlatformWhenWearModeIsDisarmed() = runBlocking {
        val root = Files.createTempDirectory("gsv-screen-disarmed-").toFile()
        try {
            val platform = FakePlatform(root)
            val runtime = WearTargetRuntimeFiles(
                authority = WearAuthority { "lease" },
                camera = SnapshotCamera { error("Camera must not be used") },
                deviceInfo = { JSONObject() },
                platform = platform,
            )

            val failed = runCatching { runtime.open(WearTargetRuntimeFiles.SCREEN_SCREENSHOT) }.exceptionOrNull()

            assertTrue(failed is TargetFsException)
            assertTrue(failed?.message.orEmpty().contains("Wear Mode is not armed"))
            assertFalse(platform.captureCalled)
        } finally {
            root.deleteRecursively()
        }
    }

    private class FakePlatform(private val root: File) : GsvPlatformOperations {
        override val status = GsvPlatformStatus(2, "test", 1)
        var captureCalled = false
        var captureFile: File? = null

        override suspend fun displaySize(): GsvDisplaySize = GsvDisplaySize(1080, 2400)

        override suspend fun captureScreenshot(maxDimension: Int): GsvPlatformCapture {
            captureCalled = true
            val file = File.createTempFile("screen-", ".png", root).also { it.writeBytes(PNG_BYTES) }
            captureFile = file
            return GsvPlatformCapture(file, "image/png")
        }

        override suspend fun foregroundActivity(): GsvForegroundActivity? = null

        override suspend fun launchApp(packageName: String) = Unit

        override suspend fun tap(x: Int, y: Int) = Unit

        override suspend fun swipe(
            startX: Int,
            startY: Int,
            endX: Int,
            endY: Int,
            durationMillis: Int,
        ) = Unit

        override suspend fun pressKey(keyName: String) = Unit

        override suspend fun typeText(text: String) = Unit
    }

    private companion object {
        val PNG_BYTES = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47)
    }
}
