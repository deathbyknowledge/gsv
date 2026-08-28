package com.humansandmachines.gsv.wear.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.shape.CutCornerShape
import androidx.compose.foundation.text.BasicText as Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.connection.ConnectionState
import com.humansandmachines.gsv.wear.runtime.RuntimeSnapshot
import com.humansandmachines.gsv.wear.voice.AssistantSnapshot
import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

class AssistantShowcaseActivity : ComponentActivity() {
    private var showcaseState by mutableStateOf(VoiceTurnState.LISTENING)
    private var showOverlay by mutableStateOf(false)
    private var morphReview by mutableStateOf(false)
    private var shipReview by mutableStateOf(false)
    private var stateReview by mutableStateOf(false)
    private var controlReview by mutableStateOf(false)
    private var controlAuthority by mutableStateOf(AuthorityState.DISARMED)
    private var shapeTarget by mutableStateOf(OrbShapeTarget.LISTENING)
    private var microphoneLevel by mutableStateOf(0f)
    private var playbackLevel by mutableStateOf(0f)
    private var signalOverride by mutableStateOf<Float?>(null)
    private var microphonePermissionDenied by mutableStateOf(false)
    private var speechSampleUnavailable by mutableStateOf(false)
    private var microphonePermissionPending = false
    private var activityResumed = false
    private var microphoneSampler: DebugMicrophoneLevelSampler? = null
    private var microphoneJob: Job? = null
    private var speechSamplePlayer: DebugSpeechSamplePlayer? = null
    private var speechSampleJob: Job? = null
    private val microphonePermissionRequest = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        microphonePermissionPending = false
        microphonePermissionDenied = !granted
        if (granted) syncSignalSources()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        updateShowcase(intent)
        setContent {
            if (shipReview) {
                ShipReviewSurface()
            } else if (controlReview) {
                GsvControlScreen(
                    wearSnapshot = RuntimeSnapshot(
                        connection = ConnectionState.CONNECTED,
                        authority = controlAuthority,
                    ),
                    assistantSnapshot = AssistantSnapshot(connection = ConnectionState.CONNECTED),
                    uiState = ControlUiState(
                        notificationStatus = "Ready",
                        assistantSelected = true,
                    ),
                    onMindToggle = {},
                    onArm = { controlAuthority = AuthorityState.ARMED },
                    onPauseOrResume = {
                        controlAuthority = if (controlAuthority == AuthorityState.PAUSED) {
                            AuthorityState.ARMED
                        } else {
                            AuthorityState.PAUSED
                        }
                    },
                    onDisarm = { controlAuthority = AuthorityState.DISARMED },
                    onDisconnect = {},
                    onActivationStarted = {},
                    onChooseAssistant = {},
                    onOpenBatterySettings = {},
                    onOpenNotificationSettings = {},
                )
            } else if (showOverlay) {
                val reviewStates = stateReview
                val reviewMorph = !reviewStates &&
                    morphReview && showcaseState == VoiceTurnState.LISTENING
                ShowcaseHostSurface()
                AssistantInvocationSurface(
                    state = showcaseState,
                    detail = when {
                        reviewStates && showcaseState == VoiceTurnState.LISTENING ->
                            if (microphonePermissionDenied) {
                                "Microphone permission is required for live listening review."
                            } else {
                                "Speak to test the receptive liquid."
                            }
                        reviewStates && showcaseState == VoiceTurnState.SPEAKING ->
                            if (speechSampleUnavailable) {
                                "The local voice sample is unavailable on this device."
                            } else {
                                "Assistant playback drives the liquid membrane."
                            }
                        reviewStates -> "Tap to compare states without restarting the liquid."
                        reviewMorph -> "Tap again at any point to redirect the liquid."
                        else -> showcaseState.detailText(this)
                    },
                    signal = reviewSignal(),
                    shapeTarget = shapeTarget,
                    coreActionDescription = when {
                        reviewStates -> "Switch assistant state"
                        reviewMorph -> "Morph assistant shape"
                        else -> "Cancel assistant"
                    },
                    coreActionLabel = when {
                        reviewStates -> "TAP CORE TO SWITCH STATE"
                        reviewMorph -> "TAP CORE TO MORPH / REVERSE"
                        else -> "TAP CORE TO DISMISS"
                    },
                    onCancel = when {
                        reviewStates -> ::toggleReviewState
                        reviewMorph -> ::toggleShape
                        else -> ::finish
                    },
                )
            } else {
                AssistantSurface(
                    state = showcaseState,
                    detail = showcaseState.detailText(this),
                    signal = reviewSignal(),
                    onCancel = ::finish,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        updateShowcase(intent)
    }

    override fun onResume() {
        super.onResume()
        activityResumed = true
        syncSignalSources()
    }

    override fun onPause() {
        activityResumed = false
        stopSignalSources()
        super.onPause()
    }

    override fun onDestroy() {
        stopSignalSources()
        super.onDestroy()
    }

    private fun updateShowcase(intent: Intent) {
        showcaseState = runCatching {
            VoiceTurnState.valueOf(intent.getStringExtra(EXTRA_STATE) ?: VoiceTurnState.LISTENING.name)
        }.getOrDefault(VoiceTurnState.LISTENING)
        shipReview = intent.getBooleanExtra(EXTRA_SHIP, false)
        showOverlay = intent.getBooleanExtra(EXTRA_OVERLAY, false)
        morphReview = intent.getBooleanExtra(EXTRA_MORPH, false)
        stateReview = intent.getBooleanExtra(EXTRA_STATES, false)
        controlReview = intent.getBooleanExtra(EXTRA_CONTROL, false)
        signalOverride = if (intent.hasExtra(EXTRA_SIGNAL)) {
            intent.getFloatExtra(EXTRA_SIGNAL, 0f).coerceIn(0f, 1f)
        } else {
            null
        }
        shapeTarget = if (shipReview) OrbShapeTarget.SHIP else OrbShapeTarget.LISTENING
        if (activityResumed) syncSignalSources()
    }

    private fun toggleReviewState() {
        showcaseState = when (showcaseState) {
            VoiceTurnState.LISTENING -> VoiceTurnState.THINKING
            VoiceTurnState.THINKING -> VoiceTurnState.SPEAKING
            else -> VoiceTurnState.LISTENING
        }
        syncSignalSources()
    }

    private fun reviewSignal(): Float = when (showcaseState) {
        VoiceTurnState.LISTENING -> signalOverride ?: microphoneLevel
        VoiceTurnState.SPEAKING -> signalOverride ?: playbackLevel
        else -> 0.74f
    }

    private fun syncSignalSources() {
        syncMicrophone()
        syncSpeechSample()
    }

    private fun syncMicrophone() {
        val shouldSample = showcaseState == VoiceTurnState.LISTENING &&
            signalOverride == null && activityResumed && !controlReview && !shipReview
        if (!shouldSample) {
            stopMicrophone()
            return
        }
        val permissionGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED
        if (!permissionGranted) {
            stopMicrophone()
            if (!microphonePermissionPending && !microphonePermissionDenied) {
                microphonePermissionPending = true
                microphonePermissionRequest.launch(Manifest.permission.RECORD_AUDIO)
            }
            return
        }
        microphonePermissionDenied = false
        if (microphoneJob?.isActive == true) return

        val sampler = DebugMicrophoneLevelSampler()
        microphoneSampler = sampler
        microphoneJob = lifecycleScope.launch {
            try {
                sampler.sample { level ->
                    runOnUiThread {
                        if (microphoneSampler === sampler) microphoneLevel = level
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                microphoneLevel = 0f
            } finally {
                sampler.close()
                if (microphoneSampler === sampler) {
                    microphoneSampler = null
                    microphoneJob = null
                    microphoneLevel = 0f
                }
            }
        }
    }

    private fun stopMicrophone() {
        val sampler = microphoneSampler
        microphoneSampler = null
        sampler?.close()
        microphoneJob?.cancel()
        microphoneJob = null
        microphoneLevel = 0f
    }

    private fun syncSpeechSample() {
        val shouldPlay = showcaseState == VoiceTurnState.SPEAKING &&
            signalOverride == null && activityResumed && !controlReview && !shipReview
        if (!shouldPlay) {
            stopSpeechSample()
            return
        }
        if (speechSampleJob?.isActive == true) return

        speechSampleUnavailable = false
        val player = DebugSpeechSamplePlayer(this)
        speechSamplePlayer = player
        speechSampleJob = lifecycleScope.launch {
            try {
                player.playLoop { level ->
                    runOnUiThread {
                        if (speechSamplePlayer === player) playbackLevel = level
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.w(SPEECH_REVIEW_LOG_TAG, "Local speech review failed", error)
                speechSampleUnavailable = true
                playbackLevel = 0f
            } finally {
                player.close()
                if (speechSamplePlayer === player) {
                    speechSamplePlayer = null
                    speechSampleJob = null
                    playbackLevel = 0f
                }
            }
        }
    }

    private fun stopSpeechSample() {
        val player = speechSamplePlayer
        speechSamplePlayer = null
        player?.close()
        speechSampleJob?.cancel()
        speechSampleJob = null
        playbackLevel = 0f
    }

    private fun stopSignalSources() {
        stopMicrophone()
        stopSpeechSample()
    }

    private fun toggleShape() {
        shapeTarget = when (shapeTarget) {
            OrbShapeTarget.LISTENING -> OrbShapeTarget.SMILE
            else -> OrbShapeTarget.LISTENING
        }
    }

    companion object {
        private const val EXTRA_STATE = "state"
        private const val EXTRA_OVERLAY = "overlay"
        private const val EXTRA_MORPH = "morph"
        private const val EXTRA_SHIP = "ship"
        private const val EXTRA_STATES = "states"
        private const val EXTRA_CONTROL = "control"
        private const val EXTRA_SIGNAL = "signal"
        private const val SPEECH_REVIEW_LOG_TAG = "GsvSpeechReview"
    }
}

@androidx.compose.runtime.Composable
private fun ShipReviewSurface() {
    var shipRenderMode by remember { mutableStateOf(ShipRenderMode.HOLOGRAM) }
    var shipOrbitRadians by remember { mutableFloatStateOf(0f) }
    var shipElevationRadians by remember {
        mutableFloatStateOf(DEFAULT_SHIP_ELEVATION_RADIANS)
    }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(GsvColor.Void)
            .semantics {
                role = Role.Button
                contentDescription = when (shipRenderMode) {
                    ShipRenderMode.PHYSICAL -> "Disarm Ship"
                    ShipRenderMode.HOLOGRAM -> "Arm Ship"
                }
            }
            .clickable(
                interactionSource = androidx.compose.runtime.remember {
                    MutableInteractionSource()
                },
                indication = null,
                onClick = {
                    shipRenderMode = when (shipRenderMode) {
                        ShipRenderMode.PHYSICAL -> ShipRenderMode.HOLOGRAM
                        ShipRenderMode.HOLOGRAM -> ShipRenderMode.PHYSICAL
                    }
                },
            )
            .pointerInput(Unit) {
                detectDragGestures { change, dragAmount ->
                    change.consume()
                    shipOrbitRadians += dragAmount.x / size.width.coerceAtLeast(1) *
                        (2f * kotlin.math.PI.toFloat())
                    shipElevationRadians = (
                        shipElevationRadians -
                            dragAmount.y / size.height.coerceAtLeast(1) *
                            kotlin.math.PI.toFloat()
                        ).coerceIn(
                        MIN_SHIP_ELEVATION_RADIANS,
                        MAX_SHIP_ELEVATION_RADIANS,
                    )
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        GsvStarField(
            modifier = Modifier.fillMaxSize(),
            horizontalParallax = kotlin.math.sin(shipOrbitRadians),
            verticalParallax = kotlin.math.sin(
                shipElevationRadians - DEFAULT_SHIP_ELEVATION_RADIANS,
            ),
        )
        AssistantCore(
            state = VoiceTurnState.LISTENING,
            shapeTarget = OrbShapeTarget.SHIP,
            accentOverride = GsvColor.Accent,
            shipOrbitRadians = shipOrbitRadians,
            shipElevationOffsetRadians =
                shipElevationRadians - DEFAULT_SHIP_ELEVATION_RADIANS,
            shipRenderMode = shipRenderMode,
            modifier = Modifier.fillMaxWidth().height(360.dp).padding(horizontal = 8.dp),
        )
        Text(
            text = when (shipRenderMode) {
                ShipRenderMode.PHYSICAL -> "SHIP // ARMED"
                ShipRenderMode.HOLOGRAM -> "SHIP // DISARMED"
            },
            modifier = Modifier
                .align(Alignment.TopCenter)
                .padding(top = 58.dp, start = 18.dp, end = 18.dp, bottom = 18.dp)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            style = GsvTextStyle.Kicker.copy(color = GsvColor.Muted),
        )
        Text(
            text = when (shipRenderMode) {
                ShipRenderMode.PHYSICAL -> "TAP TO DISARM // DRAG TO ORBIT"
                ShipRenderMode.HOLOGRAM -> "TAP TO ARM // DRAG TO ORBIT"
            },
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 52.dp),
            style = GsvTextStyle.Kicker.copy(color = GsvColor.MutedDark),
        )
    }
}

private const val DEFAULT_SHIP_ELEVATION_RADIANS = 0.6981317f
private const val MIN_SHIP_ELEVATION_RADIANS = -1.3962634f
private const val MAX_SHIP_ELEVATION_RADIANS = 1.4835298f

@androidx.compose.runtime.Composable
private fun ShowcaseHostSurface() {
    Box(
        Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(GsvColor.Deep, GsvColor.Void),
                ),
            ),
    ) {
        Column(Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 52.dp)) {
            Text("GSV // HOST SURFACE", style = GsvTextStyle.Kicker.copy(color = GsvColor.Muted))
            Spacer(Modifier.height(32.dp))
            repeat(4) { index ->
                Box(
                    Modifier
                        .fillMaxWidth(if (index % 2 == 0) 0.82f else 0.58f)
                        .height(if (index == 0) 18.dp else 10.dp)
                        .background(
                            GsvColor.Line.copy(alpha = 0.30f),
                            CutCornerShape(topEnd = 5.dp, bottomStart = 5.dp),
                        ),
                )
                Spacer(Modifier.height(17.dp))
            }
        }
    }
}
