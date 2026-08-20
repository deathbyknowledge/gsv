package com.humansandmachines.gsv.wear.camera

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Size
import android.view.Surface
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.humansandmachines.gsv.wear.authority.AuthorityLease
import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.runtime.CameraState
import java.io.Closeable
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.coroutineContext

class CameraCaptureFailure(message: String) : Exception(message)

class CapturedSnapshot internal constructor(val file: File) : Closeable {
    private val closed = AtomicBoolean(false)

    val length: Long
        get() = file.length()

    override fun close() {
        if (closed.compareAndSet(false, true)) file.delete()
    }
}

fun interface SnapshotCamera {
    suspend fun capture(lease: AuthorityLease): CapturedSnapshot
}

class CameraController(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner,
    private val authority: WearAuthority,
    private val onState: (CameraState) -> Unit,
) : SnapshotCamera, Closeable {
    private val captureMutex = Mutex()
    private val cameraExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private var provider: ProcessCameraProvider? = null

    override suspend fun capture(lease: AuthorityLease): CapturedSnapshot {
        return try {
            withTimeout(CAPTURE_TIMEOUT_MILLIS) {
                captureMutex.withLock { captureWithLease(lease) }
            }
        } catch (_: TimeoutCancellationException) {
            throw CameraCaptureFailure("Camera capture timed out")
        }
    }

    private suspend fun captureWithLease(lease: AuthorityLease): CapturedSnapshot {
        if (
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            throw CameraCaptureFailure("Camera permission is unavailable")
        }
        if (!authority.isCurrent(lease)) {
            throw CameraCaptureFailure("Wear Mode is not armed")
        }

        var output: File? = null
        var callerOwnsOutput = false
        try {
            onState(CameraState.OPENING)
            val imageCapture = imageCapture()
            withContext(Dispatchers.Main.immediate) {
                val cameraProvider = awaitProvider()
                provider = cameraProvider
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    imageCapture,
                )
            }
            output = withContext(Dispatchers.IO) {
                File.createTempFile("gsv-wear-snapshot-", ".jpg", context.cacheDir)
            }

            onState(CameraState.ACTIVE)
            takePicture(imageCapture, output)
            coroutineContext.ensureActive()
            if (!authority.isCurrent(lease)) {
                throw CameraCaptureFailure("Wear Mode authority changed during capture")
            }
            val length = output.length()
            if (length <= 0L) throw CameraCaptureFailure("Camera returned an empty image")
            if (length > MAX_SNAPSHOT_BYTES) throw CameraCaptureFailure("Camera image exceeds the size limit")

            callerOwnsOutput = true
            return CapturedSnapshot(output)
        } catch (error: CameraCaptureFailure) {
            throw error
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            throw CameraCaptureFailure("Camera capture failed")
        } finally {
            onState(CameraState.CLOSING)
            withContext(NonCancellable + Dispatchers.Main.immediate) {
                provider?.unbindAll()
                provider = null
            }
            if (!callerOwnsOutput) output?.delete()
            onState(CameraState.CLOSED)
        }
    }

    private fun imageCapture(): ImageCapture = ImageCapture.Builder()
        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
        .setTargetRotation(Surface.ROTATION_0)
        .setResolutionSelector(
            ResolutionSelector.Builder()
                .setResolutionStrategy(
                    ResolutionStrategy(
                        Size(1280, 720),
                        ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                    ),
                )
                .build(),
        )
        .build()

    private suspend fun awaitProvider(): ProcessCameraProvider = suspendCancellableCoroutine { continuation ->
        val future = ProcessCameraProvider.getInstance(context)
        val completed = AtomicBoolean(false)
        continuation.invokeOnCancellation { completed.compareAndSet(false, true) }
        future.addListener(
            {
                try {
                    val cameraProvider = future.get()
                    if (completed.compareAndSet(false, true)) {
                        continuation.resume(cameraProvider) { _, _, _ -> Unit }
                    }
                } catch (_: Exception) {
                    if (completed.compareAndSet(false, true)) {
                        continuation.resumeWith(
                            Result.failure(CameraCaptureFailure("Camera is unavailable")),
                        )
                    }
                }
            },
            ContextCompat.getMainExecutor(context),
        )
    }

    private suspend fun takePicture(imageCapture: ImageCapture, output: File) =
        suspendCancellableCoroutine { continuation ->
            val completed = AtomicBoolean(false)
            val options = ImageCapture.OutputFileOptions.Builder(output).build()
            imageCapture.takePicture(
                options,
                cameraExecutor,
                object : ImageCapture.OnImageSavedCallback {
                    override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                        if (completed.compareAndSet(false, true)) {
                            continuation.resume(Unit) { _, _, _ -> output.delete() }
                        } else {
                            output.delete()
                        }
                    }

                    override fun onError(exception: ImageCaptureException) {
                        if (completed.compareAndSet(false, true)) {
                            continuation.resumeWith(
                                Result.failure(CameraCaptureFailure("Camera capture failed")),
                            )
                        }
                    }
                },
            )
            continuation.invokeOnCancellation {
                if (completed.compareAndSet(false, true)) output.delete()
            }
        }

    override fun close() {
        ContextCompat.getMainExecutor(context).execute {
            provider?.unbindAll()
            provider = null
            onState(CameraState.CLOSED)
        }
        cameraExecutor.shutdownNow()
    }

    companion object {
        const val MAX_SNAPSHOT_BYTES = 24L * 1024 * 1024
        private const val CAPTURE_TIMEOUT_MILLIS = 5_000L
    }
}
