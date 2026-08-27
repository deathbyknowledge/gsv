package com.humansandmachines.gsv.wear.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicText as Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

@Composable
fun WearCore(
    authority: AuthorityState,
    voiceState: VoiceTurnState,
    signal: Float,
    onToggleRequested: () -> Unit,
    onActivationStarted: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val activation = remember { Animatable(if (authority == AuthorityState.DISARMED) 0f else 1f) }
    var previous by remember { mutableStateOf(authority) }
    var activating by remember { mutableStateOf(false) }

    LaunchedEffect(authority) {
        val justArmed = previous == AuthorityState.DISARMED && authority == AuthorityState.ARMED
        previous = authority
        when {
            justArmed -> {
                activating = true
                activation.snapTo(0f)
                onActivationStarted()
                activation.animateTo(1f, tween(1_550, easing = FastOutSlowInEasing))
                activating = false
            }
            authority == AuthorityState.DISARMED -> {
                activating = false
                activation.animateTo(0f, tween(760, easing = FastOutSlowInEasing))
            }
            else -> activation.animateTo(1f, tween(420, easing = FastOutSlowInEasing))
        }
    }

    val visualState = if (authority == AuthorityState.DISARMED) VoiceTurnState.IDLE else voiceState
    val targetAccent = when {
        authority == AuthorityState.DISARMED -> Color(0xFF34515A)
        authority == AuthorityState.PAUSED -> GsvColor.Amber
        voiceState == VoiceTurnState.IDLE -> GsvColor.Cyan
        else -> voiceState.accentColor()
    }
    val accent by animateColorAsState(
        targetValue = targetAccent,
        animationSpec = tween(520, easing = FastOutSlowInEasing),
        label = "wear-liquid-accent",
    )
    val ignition = if (activating) sin(activation.value * PI).toFloat().coerceAtLeast(0f) else 0f
    val scale = 0.70f + activation.value * 0.30f + ignition * 0.10f
    val alpha = 0.42f + activation.value * 0.58f
    val stateLabel = when {
        activating -> "ARMING"
        authority == AuthorityState.DISARMED -> "DORMANT"
        authority == AuthorityState.PAUSED -> "PAUSED"
        voiceState == VoiceTurnState.IDLE -> "LIVE"
        voiceState == VoiceTurnState.PREPARING -> "LINKING"
        voiceState == VoiceTurnState.LISTENING -> "LISTENING"
        voiceState == VoiceTurnState.THINKING -> "THINKING"
        voiceState == VoiceTurnState.SPEAKING -> "RESPONDING"
        else -> "INTERRUPTED"
    }
    val actionLabel = if (authority == AuthorityState.DISARMED) "ARM" else "DISARM"

    Column(
        modifier = modifier
            .semantics(mergeDescendants = true) {
                contentDescription = "Wear Mode control"
                stateDescription = stateLabel
            }
            .clickable(
                enabled = !activating,
                role = Role.Button,
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onToggleRequested,
            ),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier.size(330.dp),
            contentAlignment = Alignment.Center,
        ) {
            ActivationBloom(
                progress = activation.value,
                presence = ignition,
                accent = accent,
                modifier = Modifier.fillMaxSize(),
            )
            AssistantCore(
                state = visualState,
                signal = if (authority == AuthorityState.DISARMED) 0f else signal,
                accentOverride = accent,
                modifier = Modifier
                    .size(318.dp)
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        this.alpha = alpha
                    },
            )
        }
        Text(
            text = stateLabel,
            style = GsvTextStyle.Kicker.copy(
                color = accent,
                fontSize = 10.sp,
                letterSpacing = 2.8.sp,
                textAlign = TextAlign.Center,
            ),
        )
        Spacer(Modifier.height(12.dp))
        Box(
            modifier = Modifier.width(184.dp).height(42.dp),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(Modifier.fillMaxSize()) {
                val centerGap = 39.dp.toPx()
                val lineY = size.height / 2f
                val inset = 4.dp.toPx()
                drawLine(
                    color = accent.copy(alpha = 0.48f),
                    start = Offset(inset, lineY),
                    end = Offset(size.width / 2f - centerGap, lineY),
                    strokeWidth = 0.8.dp.toPx(),
                )
                drawLine(
                    color = accent.copy(alpha = 0.48f),
                    start = Offset(size.width / 2f + centerGap, lineY),
                    end = Offset(size.width - inset, lineY),
                    strokeWidth = 0.8.dp.toPx(),
                )
                drawCircle(
                    color = accent.copy(alpha = 0.78f),
                    radius = 1.5.dp.toPx(),
                    center = Offset(inset, lineY),
                )
                drawCircle(
                    color = accent.copy(alpha = 0.78f),
                    radius = 1.5.dp.toPx(),
                    center = Offset(size.width - inset, lineY),
                )
            }
            Text(
                text = actionLabel,
                style = GsvTextStyle.Button.copy(
                    color = if (authority == AuthorityState.DISARMED) GsvColor.CyanBright else GsvColor.White,
                    fontSize = 10.sp,
                    letterSpacing = 2.4.sp,
                    textAlign = TextAlign.Center,
                ),
            )
        }
    }
}

@Composable
private fun ActivationBloom(
    progress: Float,
    presence: Float,
    accent: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        if (presence <= 0.001f) return@Canvas
        val unit = size.minDimension / 2f
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    GsvColor.White.copy(alpha = 0.18f * presence),
                    accent.copy(alpha = 0.22f * presence),
                    Color.Transparent,
                ),
                center = center,
                radius = unit * 0.96f,
            ),
            center = center,
            radius = unit * 0.96f,
            blendMode = BlendMode.Plus,
        )
        repeat(11) { index ->
            val angle = index / 11f * PI.toFloat() * 2f + index * 0.07f
            val inner = unit * (0.28f + progress * 0.48f)
            val outer = inner + unit * (0.20f - progress * 0.08f)
            val start = Offset(
                center.x + cos(angle) * inner,
                center.y + sin(angle) * inner,
            )
            val end = Offset(
                center.x + cos(angle) * outer,
                center.y + sin(angle) * outer,
            )
            drawLine(
                color = if (index % 3 == 0) {
                    GsvColor.White.copy(alpha = 0.62f * presence)
                } else {
                    accent.copy(alpha = 0.48f * presence)
                },
                start = start,
                end = end,
                strokeWidth = if (index % 3 == 0) 1.3.dp.toPx() else 0.7.dp.toPx(),
                cap = StrokeCap.Round,
                blendMode = BlendMode.Plus,
            )
        }
        val scanY = center.y + (progress - 0.5f) * unit * 1.05f
        drawLine(
            brush = Brush.horizontalGradient(
                listOf(Color.Transparent, accent.copy(alpha = 0.70f * presence), Color.Transparent),
            ),
            start = Offset(center.x - unit * 0.82f, scanY),
            end = Offset(center.x + unit * 0.82f, scanY),
            strokeWidth = 0.8.dp.toPx(),
            blendMode = BlendMode.Plus,
        )
    }
}
