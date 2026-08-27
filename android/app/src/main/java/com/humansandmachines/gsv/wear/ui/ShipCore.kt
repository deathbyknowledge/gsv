package com.humansandmachines.gsv.wear.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
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
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.humansandmachines.gsv.wear.authority.AuthorityState
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

@Composable
fun ShipCore(
    authority: AuthorityState,
    onToggleRequested: () -> Unit,
    onActivationStarted: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val activation = remember { Animatable(if (authority == AuthorityState.DISARMED) 0f else 1f) }
    var previous by remember { mutableStateOf(authority) }
    var activating by remember { mutableStateOf(false) }
    val ambient = rememberInfiniteTransition(label = "ship-engine")
    val phase by ambient.animateFloat(
        initialValue = 0f,
        targetValue = PI.toFloat() * 2f,
        animationSpec = infiniteRepeatable(tween(8_000, easing = LinearEasing)),
        label = "ship-engine-phase",
    )

    LaunchedEffect(authority) {
        val justArmed = previous == AuthorityState.DISARMED && authority == AuthorityState.ARMED
        previous = authority
        when {
            justArmed -> {
                activating = true
                activation.snapTo(0f)
                onActivationStarted()
                activation.animateTo(1f, tween(1_800, easing = FastOutSlowInEasing))
                activating = false
            }
            authority == AuthorityState.DISARMED -> {
                activating = false
                activation.animateTo(0f, tween(900, easing = FastOutSlowInEasing))
            }
            else -> activation.animateTo(1f, tween(480, easing = FastOutSlowInEasing))
        }
    }

    val accent by animateColorAsState(
        targetValue = when (authority) {
            AuthorityState.ARMED -> GsvColor.Cyan
            AuthorityState.PAUSED -> GsvColor.Amber
            AuthorityState.DISARMED -> Color(0xFF35505A)
        },
        animationSpec = tween(520, easing = FastOutSlowInEasing),
        label = "ship-accent",
    )
    val stateLabel = when {
        activating -> "ARMING"
        authority == AuthorityState.ARMED -> "AUTHORIZED"
        authority == AuthorityState.PAUSED -> "STANDBY"
        else -> "DORMANT"
    }
    val actionLabel = if (authority == AuthorityState.DISARMED) "ARM" else "DISARM"

    Column(
        modifier = modifier
            .semantics(mergeDescendants = true) {
                contentDescription = "Ship Wear Mode control"
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
            modifier = Modifier.size(width = 350.dp, height = 292.dp),
            contentAlignment = Alignment.Center,
        ) {
            ShipHull(
                activation = activation.value,
                phase = phase,
                accent = accent,
                paused = authority == AuthorityState.PAUSED,
                ignition = if (activating) {
                    sin(activation.value * PI).toFloat().coerceAtLeast(0f)
                } else {
                    0f
                },
                modifier = Modifier.fillMaxSize(),
            )
        }
        Text(
            text = stateLabel,
            style = GsvTextStyle.Kicker.copy(
                color = accent,
                fontSize = 9.sp,
                letterSpacing = 3.1.sp,
                textAlign = TextAlign.Center,
            ),
        )
        Spacer(Modifier.height(13.dp))
        Box(
            modifier = Modifier.width(190.dp).height(40.dp),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(Modifier.fillMaxSize()) {
                val gap = 41.dp.toPx()
                val y = center.y
                drawLine(
                    color = accent.copy(alpha = 0.44f),
                    start = Offset(3.dp.toPx(), y),
                    end = Offset(center.x - gap, y),
                    strokeWidth = 0.8.dp.toPx(),
                )
                drawLine(
                    color = accent.copy(alpha = 0.44f),
                    start = Offset(center.x + gap, y),
                    end = Offset(size.width - 3.dp.toPx(), y),
                    strokeWidth = 0.8.dp.toPx(),
                )
                drawCircle(accent.copy(alpha = 0.78f), 1.4.dp.toPx(), Offset(3.dp.toPx(), y))
                drawCircle(
                    accent.copy(alpha = 0.78f),
                    1.4.dp.toPx(),
                    Offset(size.width - 3.dp.toPx(), y),
                )
            }
            Text(
                text = actionLabel,
                style = GsvTextStyle.Button.copy(
                    color = if (authority == AuthorityState.DISARMED) GsvColor.CyanBright else GsvColor.White,
                    fontSize = 10.sp,
                    letterSpacing = 2.5.sp,
                    textAlign = TextAlign.Center,
                ),
            )
        }
    }
}

@Composable
private fun ShipHull(
    activation: Float,
    phase: Float,
    accent: Color,
    paused: Boolean,
    ignition: Float,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val unfold = activation.coerceIn(0f, 1f)
        val center = Offset(size.width / 2f, size.height * 0.49f)
        val span = size.width * (0.13f + unfold * 0.34f)
        val hullHeight = size.height * (0.08f + unfold * 0.24f)
        val breath = if (unfold > 0.98f) sin(phase) * size.minDimension * 0.006f else 0f
        val pulse = if (paused) 0.48f else 0.72f + sin(phase * 1.7f) * 0.16f

        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    GsvColor.White.copy(alpha = ignition * 0.20f),
                    accent.copy(alpha = (0.08f + ignition * 0.18f) * unfold),
                    Color.Transparent,
                ),
                center = center,
                radius = size.minDimension * 0.64f,
            ),
            center = center,
            radius = size.minDimension * 0.64f,
            blendMode = BlendMode.Plus,
        )

        val orbitRect = Rect(
            left = center.x - span * 0.92f,
            top = center.y - hullHeight * 0.78f,
            right = center.x + span * 0.92f,
            bottom = center.y + hullHeight * 0.78f,
        )
        drawArc(
            color = accent.copy(alpha = 0.10f + 0.18f * unfold),
            startAngle = 194f + sin(phase) * 3f,
            sweepAngle = 152f,
            useCenter = false,
            topLeft = orbitRect.topLeft,
            size = orbitRect.size,
            style = Stroke(0.8.dp.toPx(), cap = StrokeCap.Round),
        )

        listOf(-1f, 1f).forEach { side ->
            val tipX = center.x + side * span
            val shoulderX = center.x + side * span * (0.28f + unfold * 0.18f)
            val wing = Path().apply {
                moveTo(center.x + side * 9.dp.toPx(), center.y - 5.dp.toPx())
                cubicTo(
                    shoulderX,
                    center.y - hullHeight * 0.94f - breath,
                    center.x + side * span * 0.74f,
                    center.y - hullHeight * 0.64f + breath,
                    tipX,
                    center.y - hullHeight * 0.12f,
                )
                cubicTo(
                    center.x + side * span * 0.72f,
                    center.y + hullHeight * 0.74f - breath,
                    shoulderX,
                    center.y + hullHeight * 0.76f + breath,
                    center.x + side * 11.dp.toPx(),
                    center.y + 7.dp.toPx(),
                )
                close()
            }
            drawPath(
                path = wing,
                brush = Brush.linearGradient(
                    colors = listOf(
                        Color(0xFF071116).copy(alpha = 0.96f),
                        accent.copy(alpha = 0.08f + unfold * 0.10f),
                        Color(0xFF020506).copy(alpha = 0.98f),
                    ),
                    start = Offset(center.x, center.y - hullHeight),
                    end = Offset(tipX, center.y + hullHeight),
                ),
            )
            drawPath(
                path = wing,
                color = accent.copy(alpha = 0.25f + unfold * 0.48f),
                style = Stroke((0.65f + unfold * 0.45f).dp.toPx(), cap = StrokeCap.Round),
            )

            repeat(3) { index ->
                val lane = (index + 1) / 4f
                val innerX = center.x + side * span * (0.14f + lane * 0.18f)
                val outerX = center.x + side * span * (0.35f + lane * 0.19f)
                val yBias = (index - 1) * hullHeight * 0.20f
                val conduit = Path().apply {
                    moveTo(innerX, center.y + yBias * 0.32f)
                    cubicTo(
                        center.x + side * span * 0.38f,
                        center.y + yBias - hullHeight * (0.34f - index * 0.12f),
                        center.x + side * span * 0.62f,
                        center.y + yBias + hullHeight * (0.20f - index * 0.08f),
                        outerX,
                        center.y + yBias,
                    )
                }
                drawPath(
                    path = conduit,
                    color = if (index == 1) {
                        GsvColor.White.copy(alpha = pulse * unfold * 0.42f)
                    } else {
                        accent.copy(alpha = pulse * unfold * 0.32f)
                    },
                    style = Stroke(if (index == 1) 0.9.dp.toPx() else 0.55.dp.toPx()),
                    blendMode = BlendMode.Plus,
                )
            }

            val navLight = Offset(
                center.x + side * span * 0.82f,
                center.y + hullHeight * 0.08f,
            )
            drawCircle(
                color = accent.copy(alpha = pulse * unfold),
                radius = (1.1f + ignition * 1.6f).dp.toPx(),
                center = navLight,
                blendMode = BlendMode.Plus,
            )
        }

        val coreWidth = 15.dp.toPx() + unfold * 13.dp.toPx()
        val coreHeight = 12.dp.toPx() + unfold * 26.dp.toPx()
        val core = Path().apply {
            moveTo(center.x, center.y - coreHeight)
            lineTo(center.x + coreWidth, center.y)
            lineTo(center.x, center.y + coreHeight)
            lineTo(center.x - coreWidth, center.y)
            close()
        }
        drawPath(
            path = core,
            brush = Brush.radialGradient(
                colors = listOf(
                    GsvColor.White.copy(alpha = (0.18f + ignition * 0.62f) * unfold),
                    accent.copy(alpha = 0.42f + ignition * 0.30f),
                    Color(0xFF061116),
                ),
                center = center,
                radius = coreHeight * 1.3f,
            ),
            blendMode = BlendMode.Plus,
        )
        drawPath(
            path = core,
            color = accent.copy(alpha = 0.56f + ignition * 0.36f),
            style = Stroke(0.9.dp.toPx(), cap = StrokeCap.Round),
        )
        drawCircle(
            color = GsvColor.White.copy(alpha = (0.32f + pulse * 0.38f) * unfold),
            radius = (1.5f + ignition * 2.4f).dp.toPx(),
            center = center,
            blendMode = BlendMode.Plus,
        )

        repeat(7) { index ->
            val angle = phase * 0.16f + index / 7f * PI.toFloat() * 2f
            val radiusX = span * (0.54f + (index % 2) * 0.12f)
            val radiusY = hullHeight * 0.72f
            drawCircle(
                color = accent.copy(alpha = unfold * (0.06f + (index % 3) * 0.025f)),
                radius = 0.65.dp.toPx(),
                center = Offset(
                    center.x + cos(angle) * radiusX,
                    center.y + sin(angle) * radiusY,
                ),
            )
        }
    }
}
