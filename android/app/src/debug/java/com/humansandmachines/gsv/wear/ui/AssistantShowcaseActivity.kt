package com.humansandmachines.gsv.wear.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
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
import com.humansandmachines.gsv.wear.voice.VoiceTurnState

class AssistantShowcaseActivity : ComponentActivity() {
    private var showcaseState by mutableStateOf(VoiceTurnState.LISTENING)
    private var showOverlay by mutableStateOf(false)
    private var morphReview by mutableStateOf(false)
    private var shapeTarget by mutableStateOf(OrbShapeTarget.LISTENING)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        updateShowcase(intent)
        setContent {
            if (showOverlay) {
                val reviewMorph = morphReview && showcaseState == VoiceTurnState.LISTENING
                ShowcaseHostSurface()
                AssistantInvocationSurface(
                    state = showcaseState,
                    detail = if (reviewMorph) {
                        "Tap again at any point to redirect the liquid."
                    } else {
                        showcaseState.detailText(this)
                    },
                    signal = 0.74f,
                    shapeTarget = shapeTarget,
                    coreActionDescription = if (reviewMorph) "Morph assistant shape" else "Cancel assistant",
                    coreActionLabel = if (reviewMorph) "TAP CORE TO MORPH / REVERSE" else "TAP CORE TO DISMISS",
                    onCancel = if (reviewMorph) ::toggleShape else ::finish,
                )
            } else {
                AssistantSurface(
                    state = showcaseState,
                    detail = showcaseState.detailText(this),
                    signal = 0.74f,
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

    private fun updateShowcase(intent: Intent) {
        showcaseState = runCatching {
            VoiceTurnState.valueOf(intent.getStringExtra(EXTRA_STATE) ?: VoiceTurnState.LISTENING.name)
        }.getOrDefault(VoiceTurnState.LISTENING)
        showOverlay = intent.getBooleanExtra(EXTRA_OVERLAY, false)
        morphReview = intent.getBooleanExtra(EXTRA_MORPH, false)
        shapeTarget = OrbShapeTarget.LISTENING
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
