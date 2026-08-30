package com.humansandmachines.gsv.wear.platform

import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

class GsvPlatformFailure(message: String, cause: Throwable? = null) : Exception(message, cause)

data class GsvDisplaySize(
    val width: Int,
    val height: Int,
)

data class GsvForegroundActivity(
    val packageName: String,
    val className: String,
)

class GsvPlatformCapture internal constructor(
    val file: File,
    val contentType: String,
) : AutoCloseable {
    val length: Long
        get() = file.length()

    private val closed = AtomicBoolean(false)

    override fun close() {
        if (closed.compareAndSet(false, true)) file.delete()
    }
}

interface GsvPlatformOperations {
    val status: GsvPlatformStatus?

    fun supportsAutomation(): Boolean =
        (status?.apiVersion ?: 0) >= GsvPlatformContract.AUTOMATION_API_VERSION

    suspend fun displaySize(): GsvDisplaySize

    suspend fun captureScreenshot(maxDimension: Int): GsvPlatformCapture

    suspend fun foregroundActivity(): GsvForegroundActivity?

    suspend fun launchApp(packageName: String)

    suspend fun tap(x: Int, y: Int)

    suspend fun swipe(startX: Int, startY: Int, endX: Int, endY: Int, durationMillis: Int)

    suspend fun pressKey(keyName: String)

    suspend fun typeText(text: String)
}
