package com.humansandmachines.gsv.wear.platform

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.util.Log
import com.humansandmachines.gsv.platform.IGsvPlatformService
import java.io.Closeable
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible

class GsvPlatformClient(context: Context) : GsvPlatformOperations, Closeable {
    private val applicationContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Any()
    private val captureDirectory = File(applicationContext.cacheDir, "gsv-platform-captures")

    @Volatile
    override var status: GsvPlatformStatus? = null
        private set

    @Volatile
    private var service: IGsvPlatformService? = null

    private var bindingRegistered = false
    private var closed = false
    private var connectionGeneration = 0L

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            val connectedService = IGsvPlatformService.Stub.asInterface(binder)
            val generation = synchronized(lock) {
                connectionGeneration += 1
                connectionGeneration
            }
            scope.launch {
                try {
                    val apiVersion = connectedService.apiVersion
                    if (!GsvPlatformContract.supportsApiVersion(apiVersion)) {
                        Log.e(TAG, "GSV platform API version $apiVersion is unsupported")
                        clearConnection(generation)
                        return@launch
                    }
                    val connected = GsvPlatformStatus(
                        apiVersion = apiVersion,
                        serviceVersion = connectedService.serviceVersion,
                        startedElapsedRealtimeMillis = connectedService.startedElapsedRealtimeMillis,
                    )
                    synchronized(lock) {
                        if (closed || generation != connectionGeneration || !binder.isBinderAlive) return@launch
                        service = connectedService
                        status = connected
                    }
                    Log.i(TAG, "connected api=${connected.apiVersion} service=${connected.serviceVersion}")
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    clearConnection(generation)
                    Log.w(TAG, "GSV platform handshake failed", error)
                }
            }
        }

        override fun onServiceDisconnected(name: ComponentName) {
            clearConnection()
        }

        override fun onBindingDied(name: ComponentName) {
            clearConnection()
        }

        override fun onNullBinding(name: ComponentName) {
            clearConnection()
        }
    }

    init {
        captureDirectory.listFiles()?.forEach(File::delete)
    }

    fun connect() {
        synchronized(lock) {
            if (closed || bindingRegistered) return
            val intent = Intent(GsvPlatformContract.SERVICE_ACTION).setComponent(
                ComponentName(
                    GsvPlatformContract.PACKAGE_NAME,
                    GsvPlatformContract.SERVICE_CLASS_NAME,
                ),
            )
            bindingRegistered = try {
                applicationContext.bindService(intent, connection, Context.BIND_AUTO_CREATE)
            } catch (error: SecurityException) {
                Log.w(TAG, "GSV platform service rejected the client signature", error)
                false
            }
        }
    }

    override fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            connectionGeneration += 1
            service = null
            status = null
            if (bindingRegistered) {
                applicationContext.unbindService(connection)
                bindingRegistered = false
            }
        }
        scope.cancel()
    }

    override suspend fun displaySize(): GsvDisplaySize = remoteCall {
        val size = it.displaySize ?: throw GsvPlatformFailure("GSV OS did not return a display size")
        GsvDisplaySize(size.x, size.y)
    }

    override suspend fun captureScreenshot(maxDimension: Int): GsvPlatformCapture {
        if (maxDimension !in MIN_SCREENSHOT_DIMENSION..MAX_SCREENSHOT_DIMENSION) {
            throw GsvPlatformFailure(
                "Screenshot maximum dimension must be between $MIN_SCREENSHOT_DIMENSION and $MAX_SCREENSHOT_DIMENSION",
            )
        }
        val descriptor = remoteCall { service ->
            service.captureScreenshotPng(maxDimension)
                ?: throw GsvPlatformFailure("GSV OS did not return a screenshot stream")
        }
        return copyCapture(descriptor)
    }

    override suspend fun foregroundActivity(): GsvForegroundActivity? = remoteCall { service ->
        service.foregroundActivity?.let { component ->
            GsvForegroundActivity(component.packageName, component.className)
        }
    }

    override suspend fun launchApp(packageName: String) {
        remoteCall { service ->
            if (!service.launchApp(packageName)) throw GsvPlatformFailure("GSV OS could not launch $packageName")
        }
    }

    override suspend fun tap(x: Int, y: Int) {
        remoteCall { it.tap(x, y) }
    }

    override suspend fun swipe(
        startX: Int,
        startY: Int,
        endX: Int,
        endY: Int,
        durationMillis: Int,
    ) {
        remoteCall { it.swipe(startX, startY, endX, endY, durationMillis) }
    }

    override suspend fun pressKey(keyName: String) {
        remoteCall { it.pressKey(keyName) }
    }

    override suspend fun typeText(text: String) {
        remoteCall { it.typeText(text) }
    }

    private suspend fun copyCapture(descriptor: ParcelFileDescriptor): GsvPlatformCapture =
        runInterruptible(Dispatchers.IO) {
            var file: File? = null
            try {
                ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
                    if (!captureDirectory.mkdirs() && !captureDirectory.isDirectory) {
                        throw GsvPlatformFailure("Unable to create the platform capture directory")
                    }
                    val destination = File.createTempFile("screen-", ".png", captureDirectory)
                    file = destination
                    destination.outputStream().use { output ->
                        val buffer = ByteArray(COPY_BUFFER_BYTES)
                        var total = 0L
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            if (count == 0) continue
                            total += count
                            if (total > MAX_SCREENSHOT_BYTES) {
                                throw GsvPlatformFailure("GSV OS screenshot exceeded the size limit")
                            }
                            output.write(buffer, 0, count)
                        }
                    }
                }
                val captured = checkNotNull(file)
                if (captured.length() == 0L) throw GsvPlatformFailure("GSV OS returned an empty screenshot")
                GsvPlatformCapture(captured, "image/png")
            } catch (error: Throwable) {
                file?.delete()
                throw error
            }
        }

    private suspend fun <T> remoteCall(block: (IGsvPlatformService) -> T): T =
        runInterruptible(Dispatchers.IO) {
            val connected = synchronized(lock) {
                val currentStatus = status
                if (
                    closed ||
                    currentStatus == null ||
                    currentStatus.apiVersion < GsvPlatformContract.AUTOMATION_API_VERSION
                ) {
                    null
                } else {
                    service
                }
            } ?: throw GsvPlatformFailure("GSV OS platform automation is unavailable")
            try {
                block(connected)
            } catch (error: CancellationException) {
                throw error
            } catch (error: GsvPlatformFailure) {
                throw error
            } catch (error: SecurityException) {
                throw GsvPlatformFailure("GSV OS rejected the platform operation", error)
            } catch (error: Exception) {
                throw GsvPlatformFailure("GSV OS platform operation failed", error)
            }
        }

    private fun clearConnection(expectedGeneration: Long? = null) {
        synchronized(lock) {
            if (expectedGeneration != null && expectedGeneration != connectionGeneration) return
            connectionGeneration += 1
            service = null
            status = null
        }
    }

    private companion object {
        const val TAG = "GsvPlatformClient"
        const val MIN_SCREENSHOT_DIMENSION = 256
        const val MAX_SCREENSHOT_DIMENSION = 4_096
        const val MAX_SCREENSHOT_BYTES = 32L * 1024 * 1024
        const val COPY_BUFFER_BYTES = 64 * 1024
    }
}
