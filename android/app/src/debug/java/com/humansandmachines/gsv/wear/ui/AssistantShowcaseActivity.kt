package com.humansandmachines.gsv.wear.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CutCornerShape
import androidx.compose.foundation.text.BasicText as Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

class AssistantShowcaseActivity : ComponentActivity() {
    private var showcaseState by mutableStateOf(VoiceTurnState.LISTENING)
    private var showOverlay by mutableStateOf(false)
    private var morphReview by mutableStateOf(false)
    private var stateReview by mutableStateOf(false)
    private var shapeTarget by mutableStateOf(OrbShapeTarget.LISTENING)
    private var microphoneLevel by mutableStateOf(0f)
    private var signalOverride by mutableStateOf<Float?>(null)
    private var microphonePermissionDenied by mutableStateOf(false)
    private var microphonePermissionPending = false
    private var activityResumed = false
    private var microphoneSampler: DebugMicrophoneLevelSampler? = null
    private var microphoneJob: Job? = null
    private val microphonePermissionRequest = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        microphonePermissionPending = false
        microphonePermissionDenied = !granted
        if (granted) syncMicrophone()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        updateShowcase(intent)
        setContent {
            if (showOverlay) {
                val reviewStates = stateReview
                val reviewMorph = !reviewStates &&
                    morphReview && showcaseState == VoiceTurnState.LISTENING
                ShowcaseHostSurface()
                AssistantInvocationSurface(
                    state = showcaseState,
                    detail = when {
                        reviewStates && showcaseState == VoiceTurnState.SPEAKING ->
                            if (microphonePermissionDenied) {
                                "Microphone permission is required for live surface review."
                            } else {
                                "Speak to excite the liquid membrane."
                            }
                        reviewStates -> "Tap to compare states without restarting the liquid."
                        reviewMorph -> "Tap again at any point to redirect the liquid."
                        else -> showcaseState.detailText(this)
                    },
                    signal = if (showcaseState == VoiceTurnState.SPEAKING) {
                        signalOverride ?: microphoneLevel
                    } else {
                        0.74f
                    },
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
                    signal = if (showcaseState == VoiceTurnState.SPEAKING) {
                        signalOverride ?: microphoneLevel
                    } else {
                        0.74f
                    },
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
        syncMicrophone()
    }

    override fun onPause() {
        activityResumed = false
        stopMicrophone()
        super.onPause()
    }

    override fun onDestroy() {
        stopMicrophone()
        super.onDestroy()
    }

    private fun updateShowcase(intent: Intent) {
        showcaseState = runCatching {
            VoiceTurnState.valueOf(intent.getStringExtra(EXTRA_STATE) ?: VoiceTurnState.LISTENING.name)
        }.getOrDefault(VoiceTurnState.LISTENING)
        showOverlay = intent.getBooleanExtra(EXTRA_OVERLAY, false)
        morphReview = intent.getBooleanExtra(EXTRA_MORPH, false)
        stateReview = intent.getBooleanExtra(EXTRA_STATES, false)
        signalOverride = if (intent.hasExtra(EXTRA_SIGNAL)) {
            intent.getFloatExtra(EXTRA_SIGNAL, 0f).coerceIn(0f, 1f)
        } else {
            null
        }
        shapeTarget = OrbShapeTarget.LISTENING
        if (activityResumed) syncMicrophone()
    }

    private fun toggleReviewState() {
        showcaseState = when (showcaseState) {
            VoiceTurnState.LISTENING -> VoiceTurnState.THINKING
            VoiceTurnState.THINKING -> VoiceTurnState.SPEAKING
            else -> VoiceTurnState.LISTENING
        }
        syncMicrophone()
    }

    private fun syncMicrophone() {
        val shouldSample = showcaseState == VoiceTurnState.SPEAKING &&
            signalOverride == null && activityResumed
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

    private fun toggleShape() {
        shapeTarget = when (shapeTarget) {
            OrbShapeTarget.LISTENING -> OrbShapeTarget.SMILE
            OrbShapeTarget.SMILE -> OrbShapeTarget.LISTENING
        }
    }

    companion object {
        private const val EXTRA_STATE = "state"
        private const val EXTRA_OVERLAY = "overlay"
        private const val EXTRA_MORPH = "morph"
        private const val EXTRA_STATES = "states"
        private const val EXTRA_SIGNAL = "signal"
    }
}

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
