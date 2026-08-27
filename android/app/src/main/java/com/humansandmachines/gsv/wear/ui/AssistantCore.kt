package com.humansandmachines.gsv.wear.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.text.BasicText as Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

@Composable
fun AssistantCore(
    state: VoiceTurnState,
    modifier: Modifier = Modifier,
) {
    val transition = rememberInfiniteTransition(label = "assistant-core")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1_800, easing = LinearEasing)),
        label = "assistant-phase",
    )
    val breath by transition.animateFloat(
        initialValue = 0.72f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            tween(850, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "assistant-breath",
    )
    val presence by animateFloatAsState(
        targetValue = if (state == VoiceTurnState.IDLE) 0.28f else 1f,
        animationSpec = tween(420, easing = FastOutSlowInEasing),
        label = "assistant-presence",
    )
    val accent = state.accentColor()

    Box(
        modifier = modifier.semantics {
            contentDescription = "GSV assistant ${state.stateLabel().lowercase()}"
        },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val coreCenter = center
            val unit = size.minDimension / 2f
            val pulse = breath * presence

            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(
                        accent.copy(alpha = 0.19f * pulse),
                        accent.copy(alpha = 0.055f * presence),
                        Color.Transparent,
                    ),
                    center = coreCenter,
                    radius = unit,
                ),
                center = coreCenter,
                radius = unit,
            )

            repeat(3) { ring ->
                val delayed = (phase + ring / 3f) % 1f
                val radius = unit * (0.25f + delayed * 0.67f)
                drawCircle(
                    color = accent.copy(alpha = (1f - delayed) * 0.20f * presence),
                    center = coreCenter,
                    radius = radius,
                    style = Stroke((1.8f - delayed).coerceAtLeast(0.6f).dp.toPx()),
                )
            }

            drawCircle(
                color = GsvColor.Line.copy(alpha = 0.74f),
                center = coreCenter,
                radius = unit * 0.86f,
                style = Stroke(1.dp.toPx()),
            )
            rotate(phase * 360f, coreCenter) {
                repeat(8) { index ->
                    val angle = index * 45f - 78f
                    drawArc(
                        color = accent.copy(alpha = (0.16f + 0.48f * presence) * pulse),
                        startAngle = angle,
                        sweepAngle = if (index % 2 == 0) 16f else 7f,
                        useCenter = false,
                        topLeft = Offset(coreCenter.x - unit * 0.73f, coreCenter.y - unit * 0.73f),
                        size = Size(unit * 1.46f, unit * 1.46f),
                        style = Stroke(if (index % 2 == 0) 2.dp.toPx() else 1.dp.toPx()),
                    )
                }
            }

            when (state) {
                VoiceTurnState.LISTENING -> drawListening(coreCenter, unit, phase, accent)
                VoiceTurnState.TRANSCRIBING -> drawTranscribing(coreCenter, unit, phase, accent)
                VoiceTurnState.THINKING -> drawThinking(coreCenter, unit, phase, accent)
                VoiceTurnState.SPEAKING -> drawSpeaking(coreCenter, unit, phase, accent)
                VoiceTurnState.ERROR -> drawError(coreCenter, unit, accent)
                VoiceTurnState.PREPARING -> drawPreparing(coreCenter, unit, phase, accent)
                VoiceTurnState.IDLE -> drawIdle(coreCenter, unit, accent)
            }

            drawCircle(
                brush = Brush.radialGradient(
                    listOf(GsvColor.White.copy(alpha = 0.92f * presence), accent.copy(alpha = 0.84f), Color.Transparent),
                    center = coreCenter,
                    radius = unit * 0.25f,
                ),
                center = coreCenter,
                radius = unit * 0.25f,
            )
            drawCircle(
                color = accent.copy(alpha = 0.88f * presence),
                center = coreCenter,
                radius = unit * (0.075f + 0.012f * breath),
                style = Stroke(2.dp.toPx()),
            )
        }

        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = state.shortLabel(),
                style = GsvTextStyle.Kicker.copy(
                    color = accent,
                    fontSize = 10.sp,
                    letterSpacing = 2.4.sp,
                    textAlign = TextAlign.Center,
                ),
            )
            Spacer(Modifier.height(23.dp))
            Text(
                text = "GSV // A1",
                style = GsvTextStyle.Kicker.copy(
                    color = GsvColor.MutedDark,
                    fontSize = 7.sp,
                    textAlign = TextAlign.Center,
                ),
            )
        }
    }
}

@Composable
fun AssistantSurface(
    state: VoiceTurnState,
    detail: String,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier.fillMaxSize().background(GsvColor.Void)) {
        SignalBackdrop()
        Box(Modifier.fillMaxSize().background(GsvColor.Void.copy(alpha = 0.30f)))
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(horizontal = 26.dp, vertical = 22.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("GSV // ASSISTANT", style = GsvTextStyle.Kicker)
            Spacer(Modifier.weight(1f))
            AssistantCore(state = state, modifier = Modifier.size(310.dp))
            Spacer(Modifier.height(28.dp))
            Column(
                modifier = Modifier.semantics {
                    liveRegion = LiveRegionMode.Polite
                },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                Text(
                    text = state.stateLabel(),
                    style = GsvTextStyle.Title.copy(
                        color = state.accentColor(),
                        textAlign = TextAlign.Center,
                    ),
                )
                Text(
                    text = detail,
                    style = GsvTextStyle.Body.copy(textAlign = TextAlign.Center),
                )
            }
            Spacer(Modifier.weight(1f))
            GsvButton(
                label = "Cancel",
                onClick = onCancel,
                tone = GsvButtonTone.QUIET,
            )
        }
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawListening(
    center: Offset,
    unit: Float,
    phase: Float,
    accent: Color,
) {
    val path = Path()
    val width = unit * 1.12f
    repeat(65) { index ->
        val normalized = index / 64f
        val x = center.x - width / 2f + width * normalized
        val envelope = 1f - abs(normalized * 2f - 1f)
        val wave = sin((normalized * 5.2f + phase * 2f) * PI.toFloat())
        val y = center.y + wave * unit * 0.13f * envelope
        if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
    }
    drawPath(path, accent.copy(alpha = 0.92f), style = Stroke(2.dp.toPx(), cap = StrokeCap.Round))
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawTranscribing(
    center: Offset,
    unit: Float,
    phase: Float,
    accent: Color,
) {
    repeat(7) { index ->
        val y = center.y + (index - 3) * unit * 0.10f
        val activity = 0.32f + 0.68f * abs(sin((phase * 2f + index * 0.17f) * PI.toFloat()))
        val half = unit * (0.12f + 0.39f * activity)
        drawLine(
            color = accent.copy(alpha = 0.22f + activity * 0.60f),
            start = Offset(center.x - half, y),
            end = Offset(center.x + half, y),
            strokeWidth = if (index == 3) 2.dp.toPx() else 1.dp.toPx(),
            cap = StrokeCap.Square,
        )
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawThinking(
    center: Offset,
    unit: Float,
    phase: Float,
    accent: Color,
) {
    repeat(5) { index ->
        val angle = phase * 2f * PI.toFloat() * (if (index % 2 == 0) 1f else -0.72f) + index * 1.25f
        val radius = unit * (0.25f + index * 0.075f)
        val node = Offset(
            center.x + cos(angle) * radius,
            center.y + sin(angle) * radius,
        )
        drawCircle(
            color = if (index % 2 == 0) accent else GsvColor.Violet,
            center = node,
            radius = (2.5f + index * 0.55f).dp.toPx(),
        )
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawSpeaking(
    center: Offset,
    unit: Float,
    phase: Float,
    accent: Color,
) {
    repeat(24) { index ->
        val angle = index / 24f * 2f * PI.toFloat() - PI.toFloat() / 2f
        val level = 0.32f + 0.68f * abs(sin((phase * 3f + index * 0.083f) * PI.toFloat()))
        val inner = unit * 0.27f
        val outer = inner + unit * (0.11f + level * 0.20f)
        drawLine(
            color = accent.copy(alpha = 0.34f + level * 0.62f),
            start = Offset(center.x + cos(angle) * inner, center.y + sin(angle) * inner),
            end = Offset(center.x + cos(angle) * outer, center.y + sin(angle) * outer),
            strokeWidth = 2.dp.toPx(),
            cap = StrokeCap.Square,
        )
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawPreparing(
    center: Offset,
    unit: Float,
    phase: Float,
    accent: Color,
) {
    rotate(phase * -250f, center) {
        repeat(4) { index ->
            drawArc(
                color = accent.copy(alpha = 0.36f + index * 0.13f),
                startAngle = index * 90f + 8f,
                sweepAngle = 34f,
                useCenter = false,
                topLeft = Offset(center.x - unit * 0.43f, center.y - unit * 0.43f),
                size = Size(unit * 0.86f, unit * 0.86f),
                style = Stroke((1 + index).dp.toPx()),
            )
        }
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawError(
    center: Offset,
    unit: Float,
    accent: Color,
) {
    val span = unit * 0.34f
    drawLine(accent, Offset(center.x - span, center.y - span), Offset(center.x + span, center.y + span), 2.dp.toPx())
    drawLine(accent, Offset(center.x + span, center.y - span), Offset(center.x - span, center.y + span), 2.dp.toPx())
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawIdle(
    center: Offset,
    unit: Float,
    accent: Color,
) {
    drawCircle(accent.copy(alpha = 0.36f), unit * 0.31f, center, style = Stroke(1.dp.toPx()))
}

fun VoiceTurnState.stateLabel(): String = when (this) {
    VoiceTurnState.IDLE -> "Assistant ready"
    VoiceTurnState.PREPARING -> "Establishing neural link"
    VoiceTurnState.LISTENING -> "Listening"
    VoiceTurnState.TRANSCRIBING -> "Resolving voiceprint"
    VoiceTurnState.THINKING -> "Agent is thinking"
    VoiceTurnState.SPEAKING -> "Responding"
    VoiceTurnState.ERROR -> "Link interrupted"
}

private fun VoiceTurnState.shortLabel(): String = when (this) {
    VoiceTurnState.IDLE -> "READY"
    VoiceTurnState.PREPARING -> "LINK"
    VoiceTurnState.LISTENING -> "VOICE"
    VoiceTurnState.TRANSCRIBING -> "SYNC"
    VoiceTurnState.THINKING -> "COG"
    VoiceTurnState.SPEAKING -> "TX"
    VoiceTurnState.ERROR -> "FAULT"
}

fun VoiceTurnState.accentColor(): Color = when (this) {
    VoiceTurnState.ERROR -> GsvColor.Red
    VoiceTurnState.THINKING -> GsvColor.Violet
    VoiceTurnState.SPEAKING -> GsvColor.Blue
    VoiceTurnState.TRANSCRIBING -> GsvColor.Blue
    VoiceTurnState.IDLE -> GsvColor.Muted
    VoiceTurnState.PREPARING,
    VoiceTurnState.LISTENING,
    -> GsvColor.Cyan
}
