package com.humansandmachines.gsv.wear.gesture

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.SystemClock
import android.util.Log
import android.util.Size
import android.view.Choreographer
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import com.humansandmachines.gsv.wear.camera.CameraSessionArbiter
import com.humansandmachines.gsv.wear.camera.ForegroundCameraSession
import com.humansandmachines.gsv.wear.BuildConfig
import com.humansandmachines.gsv.wear.voice.AssistantSnapshot
import java.io.Closeable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

internal class MindGestureController(
    context: Context,
    private val lifecycleOwner: LifecycleOwner,
    private val onCommand: (GestureCommand) -> Unit,
) : DefaultLifecycleObserver, ForegroundCameraSession, Closeable {
    private val applicationContext = context.applicationContext
    private val mainExecutor = ContextCompat.getMainExecutor(applicationContext)
    private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "gsv-mind-gestures")
    }
    private val mutableSnapshot = MutableStateFlow(GestureSnapshot())
    val snapshot: StateFlow<GestureSnapshot> = mutableSnapshot.asStateFlow()
    private val sequence = AtomicLong(0)
    private val stateRevision = AtomicLong(1)
    private val activeCandidateCode = AtomicInteger(NativeGestureChord.NONE.code)
    private val candidateSequence = AtomicLong(0)

    @Volatile
    private var assistant = AssistantSnapshot()
    private var requestedVisible = false
    private var lifecycleStarted = false
    private var registered = false
    private var closed = false
    private var generation = 0L
    private var provider: ProcessCameraProvider? = null
    private var analysis: ImageAnalysis? = null
    private var engine: NativeGestureEngine? = null
    private var engineLoading = false
    private var exclusivePaused = false
    private var consecutiveFailures = 0
    private var lastTimingLogElapsed = 0L
    private var lastInferenceTimestampNanos = 0L

    init {
        lifecycleOwner.lifecycle.addObserver(this)
    }

    fun setVisible(visible: Boolean) {
        mainExecutor.execute {
            if (closed || requestedVisible == visible) return@execute
            requestedVisible = visible
            reconcile()
        }
    }

    fun updateAssistant(snapshot: AssistantSnapshot) {
        val previous = assistant
        assistant = snapshot
        val wasActive = previous.turn != com.humansandmachines.gsv.wear.voice.VoiceTurnState.IDLE
        val isActive = snapshot.turn != com.humansandmachines.gsv.wear.voice.VoiceTurnState.IDLE
        if (wasActive != isActive || previous.turnId != snapshot.turnId) {
            stateRevision.incrementAndGet()
        }
    }

    fun cameraPermissionChanged() {
        mainExecutor.execute { reconcile() }
    }

    override fun onStart(owner: LifecycleOwner) {
        lifecycleStarted = true
        reconcile()
    }

    override fun onStop(owner: LifecycleOwner) {
        lifecycleStarted = false
        stopSession()
    }

    override suspend fun pauseForExclusiveUse() = withContext(Dispatchers.Main.immediate) {
        exclusivePaused = true
        unbindAnalysis()
        if (requestedVisible && lifecycleStarted) publish(GestureLinkState.PREPARING)
    }

    override suspend fun resumeAfterExclusiveUse() = withContext(Dispatchers.Main.immediate) {
        exclusivePaused = false
        if (shouldRun()) prepareAndBind()
    }

    override fun close() {
        mainExecutor.execute {
            if (closed) return@execute
            closed = true
            requestedVisible = false
            lifecycleStarted = false
            lifecycleOwner.lifecycle.removeObserver(this)
            stopSession()
            analysisExecutor.execute {
                engine?.close()
                engine = null
            }
            analysisExecutor.shutdown()
        }
    }

    private fun reconcile() {
        if (shouldRun()) startSession() else stopSession()
    }

    private fun shouldRun(): Boolean =
        !closed && requestedVisible && lifecycleStarted && !exclusivePaused && hasCameraPermission()

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED

    private fun startSession() {
        if (!registered) {
            registered = true
            val canRun = CameraSessionArbiter.register(this)
            if (!canRun) {
                exclusivePaused = true
                publish(GestureLinkState.PREPARING)
                return
            }
        }
        prepareAndBind()
    }

    private fun prepareAndBind() {
        if (!shouldRun() || analysis != null || engineLoading) return
        if (engine == null) {
            engineLoading = true
            val loadGeneration = generation
            publish(GestureLinkState.PREPARING)
            analysisExecutor.execute {
                val loaded = runCatching {
                    val palm = applicationContext.assets.open(PALM_MODEL).use { it.readBytes() }
                    val landmarks = applicationContext.assets.open(LANDMARK_MODEL).use { it.readBytes() }
                    NativeGestureEngine.create(palm, landmarks)
                }
                mainExecutor.execute {
                    engineLoading = false
                    if (closed || loadGeneration != generation) {
                        loaded.getOrNull()?.close()
                        return@execute
                    }
                    engine = loaded.getOrNull()
                    if (engine == null) {
                        publish(GestureLinkState.ERROR)
                    } else {
                        bindAnalysis(loadGeneration)
                    }
                }
            }
            return
        }
        bindAnalysis(generation)
    }

    private fun bindAnalysis(bindGeneration: Long) {
        if (!shouldRun() || analysis != null || engine == null) return
        publish(GestureLinkState.PREPARING)
        val future = ProcessCameraProvider.getInstance(applicationContext)
        future.addListener(
            {
                if (!shouldRun() || bindGeneration != generation || analysis != null) return@addListener
                runCatching {
                    val cameraProvider = future.get()
                    val analyzer = ImageAnalysis.Builder()
                        .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .setResolutionSelector(
                            ResolutionSelector.Builder()
                                .setResolutionStrategy(
                                    ResolutionStrategy(
                                        Size(640, 480),
                                        ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                                    ),
                                )
                                .build(),
                        )
                        .build()
                    analyzer.setAnalyzer(analysisExecutor, ::analyze)
                    cameraProvider.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_FRONT_CAMERA,
                        analyzer,
                    )
                    provider = cameraProvider
                    analysis = analyzer
                }.onSuccess {
                    consecutiveFailures = 0
                    publish(GestureLinkState.READY)
                }.onFailure {
                    unbindAnalysis()
                    publish(GestureLinkState.ERROR)
                }
            },
            mainExecutor,
        )
    }

    private fun analyze(image: ImageProxy) {
        try {
            val timestampNanos = image.imageInfo.timestamp
            val elapsedSinceInference = timestampNanos - lastInferenceTimestampNanos
            if (
                lastInferenceTimestampNanos != 0L &&
                elapsedSinceInference in 0 until MIN_INFERENCE_INTERVAL_NANOS
            ) {
                return
            }
            val sampleIntervalNanos = if (lastInferenceTimestampNanos == 0L) {
                0L
            } else {
                elapsedSinceInference
            }
            lastInferenceTimestampNanos = timestampNanos
            val activeEngine = engine ?: return
            val plane = image.planes.singleOrNull() ?: return recordFailure()
            val result = activeEngine.process(
                buffer = plane.buffer,
                width = image.width,
                height = image.height,
                rowStride = plane.rowStride,
                pixelStride = plane.pixelStride,
                rotationDegrees = image.imageInfo.rotationDegrees,
                sequence = sequence.incrementAndGet(),
                timestampNanos = timestampNanos,
                assistant = assistant,
                stateRevision = stateRevision.get(),
            )
            logTiming(result)
            if (result.failed) {
                recordFailure()
                return
            }
            consecutiveFailures = 0
            val progress = result.progress.coerceIn(0f, 1f)
            val previousCandidateCode = activeCandidateCode.getAndSet(result.chord.code)
            val candidateStarted = result.chord.isCandidate &&
                result.chord.code != previousCandidateCode
            val current = mutableSnapshot.value
            mutableSnapshot.value = current.copy(
                state = if (result.chord.isCandidate) {
                    GestureLinkState.TRACKING
                } else {
                    GestureLinkState.READY
                },
                progress = progress,
                candidateSequence = if (candidateStarted) {
                    candidateSequence.incrementAndGet()
                } else {
                    current.candidateSequence
                },
                candidateFillDurationMillis = if (candidateStarted) {
                    gestureCandidateFillDurationMillis(sampleIntervalNanos)
                } else {
                    current.candidateFillDurationMillis
                },
            )
            handleEvent(result)
        } finally {
            image.close()
        }
    }

    private fun handleEvent(result: NativeGestureResult) {
        val intent = when (result.event) {
            NativeGestureEvent.START -> MindGestureIntent.START
            NativeGestureEvent.STOP -> MindGestureIntent.STOP
            NativeGestureEvent.SEND -> MindGestureIntent.SEND
            NativeGestureEvent.NONE -> return
            NativeGestureEvent.UNSUPPORTED -> {
                stateRevision.incrementAndGet()
                return
            }
        }
        stateRevision.incrementAndGet()
        mutableSnapshot.value = mutableSnapshot.value.copy(
            state = GestureLinkState.READY,
            progress = 0f,
            commitSequence = mutableSnapshot.value.commitSequence + 1,
            lastCommit = intent,
        )
        dispatchCommand(GestureCommand(intent, result.voiceRequestId))
    }

    private fun dispatchCommand(command: GestureCommand) {
        mainExecutor.execute {
            if (!shouldRun()) return@execute
            if (command.intent != MindGestureIntent.START) {
                onCommand(command)
                return@execute
            }

            val dispatchGeneration = generation
            val choreographer = Choreographer.getInstance()
            // Let the committed timeline finish before microphone startup can
            // contend with its acknowledgement frames.
            choreographer.postFrameCallback {
                choreographer.postFrameCallbackDelayed(
                    {
                        if (shouldRun() && generation == dispatchGeneration) onCommand(command)
                    },
                    START_PRESENTATION_HANDOFF_MILLIS,
                )
            }
        }
    }

    private fun recordFailure() {
        consecutiveFailures += 1
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            mutableSnapshot.value = mutableSnapshot.value.copy(
                state = GestureLinkState.ERROR,
                progress = 0f,
            )
        }
    }

    private fun logTiming(result: NativeGestureResult) {
        if (!BuildConfig.DEBUG) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastTimingLogElapsed < TIMING_LOG_INTERVAL_MILLIS) return
        lastTimingLogElapsed = now
        Log.d(
            LOG_TAG,
            if (result.failed) "local inference failed" else "local inference ${result.inferenceMillis}ms",
        )
    }

    private fun stopSession() {
        generation += 1
        activeCandidateCode.set(NativeGestureChord.NONE.code)
        exclusivePaused = false
        if (registered) {
            CameraSessionArbiter.unregister(this)
            registered = false
        }
        unbindAnalysis()
        publish(GestureLinkState.OFF)
    }

    private fun unbindAnalysis() {
        analysis?.clearAnalyzer()
        analysis?.let { analyzer -> provider?.unbind(analyzer) }
        analysis = null
        provider = null
    }

    private fun publish(state: GestureLinkState) {
        mutableSnapshot.value = mutableSnapshot.value.copy(state = state, progress = 0f)
    }

    companion object {
        private const val PALM_MODEL = "hand_detector.tflite"
        private const val LANDMARK_MODEL = "hand_landmarks_detector.tflite"
        private const val MAX_CONSECUTIVE_FAILURES = 3
        private const val TIMING_LOG_INTERVAL_MILLIS = 5_000L
        private const val MIN_INFERENCE_INTERVAL_NANOS = 120_000_000L
        private const val START_PRESENTATION_HANDOFF_MILLIS = 50L
        private const val LOG_TAG = "GsvMindGesture"
    }
}
