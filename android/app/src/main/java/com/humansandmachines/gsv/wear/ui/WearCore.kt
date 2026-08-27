package com.humansandmachines.gsv.wear.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
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
fun WearCore(
    authority: AuthorityState,
    onArmRequested: () -> Unit,
    onActivationStarted: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val activation = remember { Animatable(if (authority == AuthorityState.DISARMED) 0f else 1f) }
    var previous by remember { mutableStateOf(authority) }
    var activating by remember { mutableStateOf(false) }
    val infinite = rememberInfiniteTransition(label = "wear-core")
    val rotation by infinite.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(14_000, easing = LinearEasing)),
        label = "core-rotation",
    )
    val breathing by infinite.animateFloat(
        initialValue = 0.72f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(1_700, easing = FastOutSlowInEasing),
            repeatMode = androidx.compose.animation.core.RepeatMode.Reverse,
        ),
        label = "core-breathing",
    )

    LaunchedEffect(authority) {
        val animateArm = previous == AuthorityState.DISARMED && authority == AuthorityState.ARMED
        previous = authority
        when {
            animateArm -> {
                activating = true
                activation.snapTo(0f)
                onActivationStarted()
                activation.animateTo(1f, tween(1_850, easing = FastOutSlowInEasing))
                activating = false
            }
            authority == AuthorityState.DISARMED -> {
                activating = false
                activation.animateTo(0f, tween(420))
            }
            else -> activation.animateTo(1f, tween(360))
        }
    }

    val accent = when (authority) {
        AuthorityState.ARMED -> GsvColor.Cyan
        AuthorityState.PAUSED -> GsvColor.Amber
        AuthorityState.DISARMED -> GsvColor.MutedDark
    }
    val stateLabel = when {
        activating -> "SUIT LINK // SYNCING"
        authority == AuthorityState.ARMED -> "WEAR MODE // ONLINE"
        authority == AuthorityState.PAUSED -> "WEAR MODE // PAUSED"
        else -> "WEAR MODE // STANDBY"
    }
    val actionLabel = when {
        activating -> activation.value.percentLabel()
        authority == AuthorityState.ARMED -> "ARMED"
        authority == AuthorityState.PAUSED -> "PAUSED"
        else -> "ARM"
    }

    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = modifier) {
        Box(
            modifier = Modifier
                .size(270.dp)
                .semantics {
                    contentDescription = "Wear Mode control"
                    stateDescription = stateLabel
                }
                .clickable(
                    enabled = authority == AuthorityState.DISARMED && !activating,
                    role = Role.Button,
                    onClick = onArmRequested,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(Modifier.matchParentSize()) {
                val progress = activation.value
                val center = center
                val unit = size.minDimension / 2f
                val activeAlpha = if (authority == AuthorityState.DISARMED) 0.34f else breathing

                drawCircle(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            accent.copy(alpha = 0.20f * progress * activeAlpha),
                            accent.copy(alpha = 0.05f * progress),
                            Color.Transparent,
                        ),
                        center = center,
                        radius = unit * 0.86f,
                    ),
                    center = center,
                    radius = unit * 0.86f,
                )

                drawCircle(
                    color = GsvColor.Line.copy(alpha = 0.65f),
                    radius = unit * 0.92f,
                    center = center,
                    style = Stroke(1.dp.toPx()),
                )
                drawCircle(
                    color = accent.copy(alpha = (0.26f + 0.4f * progress) * activeAlpha),
                    radius = unit * (0.72f + 0.03f * progress),
                    center = center,
                    style = Stroke((1.2f + progress).dp.toPx()),
                )

                rotate(rotation * (0.16f + progress * 0.84f), center) {
                    repeat(12) { index ->
                        val stagger = ((progress * 1.35f) - index / 18f).coerceIn(0f, 1f)
                        val angle = index * 30f - 84f
                        drawArc(
                            color = accent.copy(alpha = (0.10f + stagger * 0.72f) * activeAlpha),
                            startAngle = angle,
                            sweepAngle = 13f + stagger * 7f,
                            useCenter = false,
                            topLeft = Offset(center.x - unit * 0.83f, center.y - unit * 0.83f),
                            size = Size(unit * 1.66f, unit * 1.66f),
                            style = Stroke(
                                width = (1.5f + stagger * 2.5f).dp.toPx(),
                                cap = StrokeCap.Square,
                            ),
                        )
                    }
                }

                rotate(-rotation * 0.52f, center) {
                    repeat(6) { index ->
                        val angle = index * 60f + 7f
                        drawArc(
                            color = accent.copy(alpha = (0.18f + progress * 0.62f) * activeAlpha),
                            startAngle = angle,
                            sweepAngle = 34f,
                            useCenter = false,
                            topLeft = Offset(center.x - unit * 0.58f, center.y - unit * 0.58f),
                            size = Size(unit * 1.16f, unit * 1.16f),
                            style = Stroke(2.dp.toPx(), cap = StrokeCap.Square),
                        )
                    }
                }

                val plateProgress = FastOutSlowInEasing.transform(progress)
                repeat(6) { index ->
                    val angle = Math.toRadians((index * 60.0) - 90.0)
                    val inner = unit * (0.20f + (1f - plateProgress) * 0.17f)
                    val outer = unit * (0.50f + (1f - plateProgress) * 0.14f)
                    val start = Offset(
                        center.x + cos(angle).toFloat() * inner,
                        center.y + sin(angle).toFloat() * inner,
                    )
                    val end = Offset(
                        center.x + cos(angle).toFloat() * outer,
                        center.y + sin(angle).toFloat() * outer,
                    )
                    drawLine(
                        color = accent.copy(alpha = (0.22f + 0.66f * progress) * activeAlpha),
                        start = start,
                        end = end,
                        strokeWidth = (1f + progress).dp.toPx(),
                        cap = StrokeCap.Square,
                    )
                }

                val coreRadius = unit * (0.14f + 0.05f * progress)
                drawCircle(
                    brush = Brush.radialGradient(
                        listOf(GsvColor.White.copy(alpha = 0.95f * progress), accent.copy(alpha = 0.82f), Color.Transparent),
                        center = center,
                        radius = coreRadius * 2.7f,
                    ),
                    center = center,
                    radius = coreRadius * 2.7f,
                )
                drawHexCore(center, coreRadius, accent, progress, activeAlpha)

                val sweepAngle = (rotation * 1.8f - 90f) * PI.toFloat() / 180f
                val sweepStart = Offset(
                    center.x + cos(sweepAngle) * unit * 0.25f,
                    center.y + sin(sweepAngle) * unit * 0.25f,
                )
                val sweepEnd = Offset(
                    center.x + cos(sweepAngle) * unit * 0.69f,
                    center.y + sin(sweepAngle) * unit * 0.69f,
                )
                drawLine(
                    color = accent.copy(alpha = 0.46f * progress * activeAlpha),
                    start = sweepStart,
                    end = sweepEnd,
                    strokeWidth = 1.dp.toPx(),
                )

                repeat(4) { index ->
                    val horizontal = index % 2 == 0
                    val sign = if (index < 2) -1f else 1f
                    val offset = unit * (1.02f - progress * 0.06f) * sign
                    if (horizontal) {
                        drawLine(
                            GsvColor.Line.copy(alpha = 0.8f),
                            Offset(center.x + offset, center.y - 12.dp.toPx()),
                            Offset(center.x + offset, center.y + 12.dp.toPx()),
                            1.dp.toPx(),
                        )
                    } else {
                        drawLine(
                            GsvColor.Line.copy(alpha = 0.8f),
                            Offset(center.x - 12.dp.toPx(), center.y + offset),
                            Offset(center.x + 12.dp.toPx(), center.y + offset),
                            1.dp.toPx(),
                        )
                    }
                }
            }

            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = actionLabel,
                    style = GsvTextStyle.Kicker.copy(
                        color = if (authority == AuthorityState.DISARMED && !activating) GsvColor.White else accent,
                        fontSize = if (actionLabel.length <= 6) 14.sp else 11.sp,
                        letterSpacing = 2.6.sp,
                        textAlign = TextAlign.Center,
                    ),
                )
                Spacer(Modifier.height(7.dp))
                Text("CORE // 01", style = GsvTextStyle.Kicker.copy(color = GsvColor.MutedDark, fontSize = 8.sp))
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(stateLabel, style = GsvTextStyle.Kicker.copy(color = accent, textAlign = TextAlign.Center))
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawHexCore(
    center: Offset,
    radius: Float,
    accent: Color,
    progress: Float,
    alpha: Float,
) {
    val path = Path()
    repeat(6) { index ->
        val angle = Math.toRadians(index * 60.0 - 90.0)
        val point = Offset(
            center.x + cos(angle).toFloat() * radius,
            center.y + sin(angle).toFloat() * radius,
        )
        if (index == 0) path.moveTo(point.x, point.y) else path.lineTo(point.x, point.y)
    }
    path.close()
    drawPath(path, accent.copy(alpha = (0.18f + 0.32f * progress) * alpha))
    drawPath(
        path,
        GsvColor.CyanBright.copy(alpha = (0.28f + 0.68f * progress) * alpha),
        style = Stroke((1f + progress).dp.toPx()),
    )
}
