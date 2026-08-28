package com.humansandmachines.gsv.wear.ui

import android.graphics.RuntimeShader
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.dp
import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

@Composable
internal fun AssistantEnergyField(
    state: VoiceTurnState,
    phaseSeconds: Float,
    energy: Float,
    accent: Color,
    shapeParameters: OrbShapeParameters,
    liquidParameters: AssistantLiquidParameters,
    shipOrbitRadians: Float,
    shipElevationOffsetRadians: Float,
    shipMaterialization: Float,
    modifier: Modifier = Modifier,
) {
    val assistantShader = rememberRuntimeShader(ASSISTANT_SHADER)
    val liquidShader = rememberRuntimeShader(ASSISTANT_LIQUID_SHADER)
    val assistantBrush = remember(assistantShader) { assistantShader?.let(::ShaderBrush) }
    val liquidBrush = remember(liquidShader) { liquidShader?.let(::ShaderBrush) }

    Canvas(modifier) {
        val renderAssistantLiquid = state.usesAssistantLiquid() &&
            liquidShader != null && liquidBrush != null &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        if (renderAssistantLiquid) {
            configureAssistantLiquidShader(
                shader = liquidShader,
                size = size,
                phaseSeconds = phaseSeconds,
                energy = energy,
                accent = accent,
                shapeParameters = shapeParameters,
                liquidParameters = liquidParameters,
                shipOrbitRadians = shipOrbitRadians,
                shipElevationOffsetRadians = shipElevationOffsetRadians,
                shipMaterialization = shipMaterialization,
            )
            drawRect(brush = liquidBrush, blendMode = BlendMode.SrcOver)
        } else if (
            assistantShader != null && assistantBrush != null &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        ) {
            configureShader(assistantShader, size, phaseSeconds, energy, state, accent)
            drawRect(brush = assistantBrush, blendMode = BlendMode.Plus)
        } else {
            drawFallbackGlow(accent, energy, phaseSeconds)
        }
        if (!renderAssistantLiquid) {
            drawEngineeredGeometry(state, phaseSeconds, energy, accent)
        }
    }
}

@Composable
internal fun AssistantBackdrop(
    state: VoiceTurnState,
    phaseSeconds: Float,
    modifier: Modifier = Modifier,
) {
    val accent by animateColorAsState(
        targetValue = state.accentColor(),
        animationSpec = tween(480, easing = FastOutSlowInEasing),
        label = "assistant-backdrop-accent",
    )
    Canvas(modifier) {
        if (state.usesAssistantLiquid()) {
            drawAssistantLiquidBackdrop(accent, phaseSeconds)
            return@Canvas
        }
        drawRect(
            brush = Brush.verticalGradient(
                0f to Color(0xFF050414),
                0.48f to Color(0xFF0A0822),
                1f to Color(0xFF050414),
            ),
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(accent.copy(alpha = 0.13f), Color.Transparent),
                center = Offset(size.width * 0.5f, size.height * 0.39f),
                radius = size.minDimension * 0.72f,
            ),
            center = Offset(size.width * 0.5f, size.height * 0.39f),
            radius = size.minDimension * 0.72f,
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(Color.Transparent, GsvColor.Void.copy(alpha = 0.93f)),
                center = center,
                radius = size.maxDimension * 0.68f,
            ),
            center = center,
            radius = size.maxDimension * 0.68f,
        )

        val horizonY = size.height * 0.64f
        repeat(4) { index ->
            val span = size.width * (0.62f + index * 0.22f)
            val height = 24.dp.toPx() + index * 18.dp.toPx()
            drawArc(
                color = accent.copy(alpha = 0.075f - index * 0.011f),
                startAngle = 196f,
                sweepAngle = 148f,
                useCenter = false,
                topLeft = Offset(center.x - span / 2f, horizonY - height / 2f),
                size = Size(span, height),
                style = Stroke(0.7.dp.toPx()),
            )
        }

        repeat(38) { index ->
            val x = ((index * 73) % 101) / 101f * size.width
            val y = ((index * 47 + 13) % 97) / 97f * size.height
            val twinkle = 0.25f + 0.75f * abs(sin(phaseSeconds * 0.55f + index * 1.73f))
            drawCircle(
                color = if (index % 5 == 0) accent.copy(alpha = 0.19f * twinkle) else GsvColor.White.copy(alpha = 0.08f * twinkle),
                center = Offset(x, y),
                radius = if (index % 7 == 0) 1.15.dp.toPx() else 0.55.dp.toPx(),
            )
        }

        val scanY = (phaseSeconds % 7f) / 7f * size.height
        drawRect(
            brush = Brush.verticalGradient(
                listOf(Color.Transparent, accent.copy(alpha = 0.045f), Color.Transparent),
                startY = scanY - 42.dp.toPx(),
                endY = scanY + 42.dp.toPx(),
            ),
            topLeft = Offset(0f, scanY - 42.dp.toPx()),
            size = Size(size.width, 84.dp.toPx()),
        )
    }
}

@Composable
private fun rememberRuntimeShader(source: String): RuntimeShader? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return null
    return remember(source) { runCatching { RuntimeShader(source) }.getOrNull() }
}

private fun DrawScope.drawAssistantLiquidBackdrop(accent: Color, phaseSeconds: Float) {
    val phase = phaseSeconds / 12f * PI.toFloat() * 2f
    drawRect(
        brush = Brush.verticalGradient(
            0f to Color(0xFF050414),
            0.46f to Color(0xFF0A0822),
            1f to Color(0xFF050414),
        ),
    )
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(accent.copy(alpha = 0.105f), accent.copy(alpha = 0.018f), Color.Transparent),
            center = Offset(size.width * 0.57f, size.height * 0.40f),
            radius = size.minDimension * 0.64f,
        ),
        center = Offset(size.width * 0.57f, size.height * 0.40f),
        radius = size.minDimension * 0.64f,
    )
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(Color(0xFFFFB94D).copy(alpha = 0.035f), Color.Transparent),
            center = Offset(size.width * 0.34f, size.height * 0.39f),
            radius = size.minDimension * 0.42f,
        ),
        center = Offset(size.width * 0.34f, size.height * 0.39f),
        radius = size.minDimension * 0.42f,
    )
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(Color.Transparent, GsvColor.Void.copy(alpha = 0.94f)),
            center = center,
            radius = size.maxDimension * 0.67f,
        ),
        center = center,
        radius = size.maxDimension * 0.67f,
    )

    repeat(30) { index ->
        val x = ((index * 73) % 101) / 101f * size.width
        val y = ((index * 47 + 13) % 97) / 97f * size.height
        val frequency = 1f + index % 3
        val twinkle = 0.5f + 0.5f * sin(phase * frequency + index * 1.73f)
        drawCircle(
            color = if (index % 6 == 0) {
                accent.copy(alpha = 0.11f * twinkle)
            } else {
                GsvColor.White.copy(alpha = 0.045f * twinkle)
            },
            center = Offset(x, y),
            radius = if (index % 8 == 0) 0.9.dp.toPx() else 0.45.dp.toPx(),
        )
    }
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
private fun configureShader(
    shader: RuntimeShader,
    size: Size,
    phaseSeconds: Float,
    energy: Float,
    state: VoiceTurnState,
    accent: Color,
) {
    shader.setFloatUniform("iResolution", size.width, size.height)
    shader.setFloatUniform("iTime", phaseSeconds)
    shader.setFloatUniform("iEnergy", energy.coerceIn(0f, 1f))
    shader.setFloatUniform("iMode", state.ordinal.toFloat())
    shader.setFloatUniform("iAccent", accent.red, accent.green, accent.blue, 1f)
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
private fun configureAssistantLiquidShader(
    shader: RuntimeShader,
    size: Size,
    phaseSeconds: Float,
    energy: Float,
    accent: Color,
    shapeParameters: OrbShapeParameters,
    liquidParameters: AssistantLiquidParameters,
    shipOrbitRadians: Float,
    shipElevationOffsetRadians: Float,
    shipMaterialization: Float,
) {
    shader.setFloatUniform("iResolution", size.width, size.height)
    shader.setFloatUniform("iTime", phaseSeconds)
    shader.setFloatUniform("iEnergy", energy.coerceIn(0f, 1f))
    shader.setFloatUniform("iAccent", accent.red, accent.green, accent.blue, 1f)
    shader.setFloatUniform(
        "iShape",
        shapeParameters.organicAmount.coerceIn(0f, 1f),
        shapeParameters.symbolPresence.coerceIn(0f, 1f),
        shapeParameters.shipPresence.coerceIn(0f, 1f),
        shapeParameters.smileCurve.coerceIn(0f, 1.4f),
    )
    shader.setFloatUniform(
        "iBehavior",
        liquidParameters.focus.coerceIn(0f, 1f),
        liquidParameters.foldComplexity.coerceIn(0f, 1f),
        liquidParameters.internalActivity.coerceIn(0f, 1f),
        liquidParameters.projection.coerceIn(0f, 1f),
    )
    shader.setFloatUniform(
        "iShipView",
        shipOrbitRadians,
        shipElevationOffsetRadians,
    )
    shader.setFloatUniform(
        "iShipMaterialization",
        shipMaterialization.coerceIn(0f, 1f),
    )
}

private fun DrawScope.drawFallbackGlow(accent: Color, energy: Float, phaseSeconds: Float) {
    val pulse = 0.86f + 0.14f * sin(phaseSeconds * 2.1f)
    val radius = size.minDimension * (0.42f + energy * 0.04f)
    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(
                GsvColor.White.copy(alpha = 0.15f + energy * 0.09f),
                accent.copy(alpha = 0.19f * pulse),
                accent.copy(alpha = 0.045f),
                Color.Transparent,
            ),
            center = center,
            radius = radius,
        ),
        center = center,
        radius = radius,
    )
}

private fun DrawScope.drawEngineeredGeometry(
    state: VoiceTurnState,
    phaseSeconds: Float,
    energy: Float,
    accent: Color,
) {
    val origin = center
    val unit = size.minDimension / 2f
    val presence = if (state == VoiceTurnState.IDLE) 0.44f else 1f
    val slowRotation = phaseSeconds * 7.5f

    drawPerspectiveOrbits(origin, unit, phaseSeconds, accent, presence)
    drawOuterAssembly(origin, unit, slowRotation, accent, presence)
    drawIris(origin, unit, phaseSeconds, energy, accent, presence)
    drawStateSignature(state, origin, unit, phaseSeconds, energy, accent)
    drawParticles(origin, unit, phaseSeconds, energy, accent, presence)

    drawCircle(
        brush = Brush.radialGradient(
            colors = listOf(
                Color.White.copy(alpha = 0.96f),
                accent.copy(alpha = 0.88f),
                accent.copy(alpha = 0.12f),
                Color.Transparent,
            ),
            center = origin,
            radius = unit * (0.18f + energy * 0.018f),
        ),
        center = origin,
        radius = unit * (0.18f + energy * 0.018f),
        blendMode = BlendMode.Plus,
    )
    drawCircle(
        color = GsvColor.White.copy(alpha = 0.90f * presence),
        center = origin,
        radius = unit * (0.031f + energy * 0.006f),
    )
}

private fun DrawScope.drawPerspectiveOrbits(
    origin: Offset,
    unit: Float,
    phaseSeconds: Float,
    accent: Color,
    presence: Float,
) {
    repeat(3) { index ->
        val width = unit * (1.46f - index * 0.13f)
        val height = unit * (0.42f + index * 0.08f)
        rotate((index - 1) * 31f + sin(phaseSeconds * 0.28f + index) * 5f, origin) {
            drawArc(
                color = accent.copy(alpha = (0.15f - index * 0.025f) * presence),
                startAngle = 202f + index * 21f,
                sweepAngle = 108f + index * 19f,
                useCenter = false,
                topLeft = Offset(origin.x - width / 2f, origin.y - height / 2f),
                size = Size(width, height),
                style = Stroke(
                    width = if (index == 0) 1.15.dp.toPx() else 0.65.dp.toPx(),
                    cap = StrokeCap.Round,
                    pathEffect = PathEffect.dashPathEffect(
                        floatArrayOf((14 - index * 3).dp.toPx(), (7 + index * 3).dp.toPx()),
                        phaseSeconds * (8 + index * 3).dp.toPx(),
                    ),
                ),
            )
        }
    }
}

private fun DrawScope.drawOuterAssembly(
    origin: Offset,
    unit: Float,
    rotation: Float,
    accent: Color,
    presence: Float,
) {
    drawCircle(
        color = GsvColor.Line.copy(alpha = 0.64f * presence),
        center = origin,
        radius = unit * 0.79f,
        style = Stroke(0.8.dp.toPx()),
    )
    rotate(rotation, origin) {
        repeat(12) { index ->
            val strong = index % 3 == 0
            val radius = unit * if (strong) 0.735f else 0.705f
            drawArc(
                color = if (strong) {
                    accent.copy(alpha = 0.72f * presence)
                } else {
                    GsvColor.Muted.copy(alpha = 0.31f * presence)
                },
                startAngle = index * 30f + 3.2f,
                sweepAngle = if (strong) 17.5f else 9f,
                useCenter = false,
                topLeft = Offset(origin.x - radius, origin.y - radius),
                size = Size(radius * 2f, radius * 2f),
                style = Stroke(
                    width = if (strong) 2.1.dp.toPx() else 0.8.dp.toPx(),
                    cap = StrokeCap.Square,
                ),
            )
        }
    }
    rotate(-rotation * 1.7f, origin) {
        repeat(6) { index ->
            val radius = unit * 0.61f
            drawArc(
                color = accent.copy(alpha = (0.24f + if (index == 0) 0.28f else 0f) * presence),
                startAngle = index * 60f + 11f,
                sweepAngle = 24f,
                useCenter = false,
                topLeft = Offset(origin.x - radius, origin.y - radius),
                size = Size(radius * 2f, radius * 2f),
                style = Stroke(if (index == 0) 2.4.dp.toPx() else 1.dp.toPx(), cap = StrokeCap.Round),
            )
        }
    }
}

private fun DrawScope.drawIris(
    origin: Offset,
    unit: Float,
    phaseSeconds: Float,
    energy: Float,
    accent: Color,
    presence: Float,
) {
    val inner = unit * (0.17f + energy * 0.014f)
    val outer = unit * (0.48f + energy * 0.028f)
    rotate(-phaseSeconds * 3.2f, origin) {
        repeat(6) { index ->
            rotate(index * 60f, origin) {
                val path = Path().apply {
                    moveTo(origin.x, origin.y - inner)
                    cubicTo(
                        origin.x + outer * 0.13f,
                        origin.y - outer * 0.86f,
                        origin.x + outer * 0.54f,
                        origin.y - outer * 0.51f,
                        origin.x + outer * 0.67f,
                        origin.y - outer * 0.18f,
                    )
                    cubicTo(
                        origin.x + outer * 0.37f,
                        origin.y - outer * 0.24f,
                        origin.x + inner * 0.34f,
                        origin.y - inner * 0.17f,
                        origin.x,
                        origin.y - inner,
                    )
                    close()
                }
                drawPath(
                    path = path,
                    brush = Brush.linearGradient(
                        colors = listOf(
                            accent.copy(alpha = 0.04f),
                            accent.copy(alpha = (0.20f + index * 0.014f) * presence),
                            Color.Transparent,
                        ),
                        start = Offset(origin.x, origin.y - inner),
                        end = Offset(origin.x + outer * 0.65f, origin.y - outer * 0.32f),
                    ),
                    blendMode = BlendMode.Plus,
                )
                drawPath(
                    path = path,
                    color = accent.copy(alpha = (0.25f + index * 0.025f) * presence),
                    style = Stroke(0.65.dp.toPx()),
                )
            }
        }
    }
    drawCircle(
        color = accent.copy(alpha = 0.62f * presence),
        center = origin,
        radius = inner,
        style = Stroke(1.dp.toPx()),
    )
}

private fun DrawScope.drawStateSignature(
    state: VoiceTurnState,
    origin: Offset,
    unit: Float,
    phaseSeconds: Float,
    energy: Float,
    accent: Color,
) {
    when (state) {
        VoiceTurnState.IDLE -> drawIdleSignature(origin, unit, phaseSeconds, accent)
        VoiceTurnState.PREPARING -> drawPreparingSignature(origin, unit, phaseSeconds, accent)
        VoiceTurnState.LISTENING -> drawListeningSignature(origin, unit, phaseSeconds, energy, accent)
        VoiceTurnState.THINKING -> drawThinkingSignature(origin, unit, phaseSeconds, accent)
        VoiceTurnState.SPEAKING -> drawSpeakingSignature(origin, unit, phaseSeconds, accent)
        VoiceTurnState.ERROR -> drawErrorSignature(origin, unit, phaseSeconds, accent)
    }
}

private fun DrawScope.drawListeningSignature(
    origin: Offset,
    unit: Float,
    phaseSeconds: Float,
    energy: Float,
    accent: Color,
) {
    val responsiveEnergy = max(0.10f, energy)
    repeat(40) { index ->
        val angle = index / 40f * PI.toFloat() * 2f - PI.toFloat() / 2f
        val texture = 0.48f + 0.52f * abs(sin(index * 1.91f + phaseSeconds * 4.4f))
        val level = responsiveEnergy * texture
        val inner = unit * 0.29f
        val outer = inner + unit * (0.018f + level * 0.095f)
        drawLine(
            color = accent.copy(alpha = 0.42f + level * 0.55f),
            start = Offset(origin.x + cos(angle) * inner, origin.y + sin(angle) * inner),
            end = Offset(origin.x + cos(angle) * outer, origin.y + sin(angle) * outer),
            strokeWidth = if (index % 5 == 0) 1.6.dp.toPx() else 0.8.dp.toPx(),
            cap = StrokeCap.Round,
        )
    }
    repeat(2) { index ->
        val travel = (phaseSeconds * (0.55f + index * 0.11f) + index * 0.43f) % 1f
        drawCircle(
            color = accent.copy(alpha = (1f - travel) * 0.24f),
            center = origin,
            radius = unit * (0.34f + travel * 0.29f),
            style = Stroke((1.4f - travel * 0.8f).dp.toPx()),
        )
    }
}

private fun DrawScope.drawThinkingSignature(
    origin: Offset,
    unit: Float,
    phaseSeconds: Float,
    accent: Color,
) {
    val nodes = List(6) { index ->
        val angle = index * 1.83f + phaseSeconds * if (index % 2 == 0) 0.36f else -0.24f
        val radius = unit * (0.20f + (index % 3) * 0.09f)
        Offset(origin.x + cos(angle) * radius, origin.y + sin(angle) * radius)
    }
    nodes.forEachIndexed { index, node ->
        val next = nodes[(index + 2) % nodes.size]
        drawLine(
            color = accent.copy(alpha = 0.16f + (index % 2) * 0.09f),
            start = node,
            end = next,
            strokeWidth = 0.65.dp.toPx(),
        )
    }
    nodes.forEachIndexed { index, node ->
        val pulse = 0.55f + 0.45f * abs(sin(phaseSeconds * 3.4f + index))
        drawCircle(
            brush = Brush.radialGradient(
                listOf(GsvColor.White.copy(alpha = 0.92f), accent.copy(alpha = 0.66f), Color.Transparent),
                node,
                unit * 0.035f,
            ),
            center = node,
            radius = unit * 0.035f * pulse,
            blendMode = BlendMode.Plus,
        )
    }
}

private fun DrawScope.drawSpeakingSignature(
    origin: Offset,
    unit: Float,
    phaseSeconds: Float,
    accent: Color,
) {
    repeat(3) { index ->
        val travel = (phaseSeconds * 0.72f + index / 3f) % 1f
        val radius = unit * (0.27f + travel * 0.36f)
        drawArc(
            color = accent.copy(alpha = (1f - travel) * 0.48f),
            startAngle = 208f + index * 13f,
            sweepAngle = 124f - index * 9f,
            useCenter = false,
            topLeft = Offset(origin.x - radius, origin.y - radius),
            size = Size(radius * 2f, radius * 2f),
            style = Stroke((2.1f - travel).dp.toPx(), cap = StrokeCap.Round),
        )
    }
    repeat(5) { index ->
        val angle = (-38 + index * 19).toFloat() / 180f * PI.toFloat()
        val reach = unit * (0.40f + 0.08f * abs(sin(phaseSeconds * 4f + index)))
        drawLine(
            color = accent.copy(alpha = 0.21f),
            start = Offset(origin.x + cos(angle) * unit * 0.27f, origin.y + sin(angle) * unit * 0.27f),
            end = Offset(origin.x + cos(angle) * reach, origin.y + sin(angle) * reach),
            strokeWidth = 0.8.dp.toPx(),
        )
    }
}

private fun DrawScope.drawPreparingSignature(
    origin: Offset,
    unit: Float,
    phaseSeconds: Float,
    accent: Color,
) {
    rotate(phaseSeconds * -52f, origin) {
        repeat(6) { index ->
            val radius = unit * (0.29f + index * 0.035f)
            drawArc(
                color = accent.copy(alpha = 0.25f + index * 0.075f),
                startAngle = index * 60f + 8f,
                sweepAngle = 19f + index * 1.7f,
                useCenter = false,
                topLeft = Offset(origin.x - radius, origin.y - radius),
                size = Size(radius * 2f, radius * 2f),
                style = Stroke((0.7f + index * 0.19f).dp.toPx(), cap = StrokeCap.Round),
            )
        }
    }
}

private fun DrawScope.drawErrorSignature(
    origin: Offset,
    unit: Float,
    phaseSeconds: Float,
    accent: Color,
) {
    val jitter = sin(phaseSeconds * 31f) * unit * 0.018f
    repeat(5) { index ->
        val y = origin.y + (index - 2) * unit * 0.105f
        val width = unit * (0.17f + (index % 3) * 0.08f)
        drawLine(
            color = accent.copy(alpha = 0.35f + index * 0.1f),
            start = Offset(origin.x - width + jitter * (index % 2), y),
            end = Offset(origin.x + width + jitter * (1 - index % 2), y),
            strokeWidth = if (index == 2) 2.1.dp.toPx() else 0.8.dp.toPx(),
        )
    }
    val span = unit * 0.24f
    drawLine(accent, Offset(origin.x - span, origin.y - span), Offset(origin.x + span, origin.y + span), 1.2.dp.toPx())
    drawLine(accent, Offset(origin.x + span, origin.y - span), Offset(origin.x - span, origin.y + span), 1.2.dp.toPx())
}

private fun DrawScope.drawIdleSignature(
    origin: Offset,
    unit: Float,
    phaseSeconds: Float,
    accent: Color,
) {
    val breath = 0.5f + 0.5f * sin(phaseSeconds * 1.3f)
    drawCircle(
        color = accent.copy(alpha = 0.18f + breath * 0.15f),
        center = origin,
        radius = unit * (0.29f + breath * 0.014f),
        style = Stroke(0.8.dp.toPx()),
    )
}

private fun DrawScope.drawParticles(
    origin: Offset,
    unit: Float,
    phaseSeconds: Float,
    energy: Float,
    accent: Color,
    presence: Float,
) {
    repeat(19) { index ->
        val angle = index * 2.399f + phaseSeconds * (0.045f + (index % 4) * 0.012f)
        val orbit = unit * (0.38f + ((index * 37) % 43) / 100f)
        val point = Offset(origin.x + cos(angle) * orbit, origin.y + sin(angle) * orbit)
        val twinkle = 0.32f + 0.68f * abs(sin(phaseSeconds * 1.8f + index * 0.91f))
        drawCircle(
            color = accent.copy(alpha = (0.10f + energy * 0.14f) * twinkle * presence),
            center = point,
            radius = if (index % 6 == 0) 1.4.dp.toPx() else 0.65.dp.toPx(),
        )
    }
}

private const val ASSISTANT_SHADER = """
uniform float2 iResolution;
uniform float iTime;
uniform float iEnergy;
uniform float iMode;
uniform float4 iAccent;

float band(float value, float center, float width) {
    return 1.0 - smoothstep(width, width * 2.2, abs(value - center));
}

float hash21(float2 point) {
    point = fract(point * float2(123.34, 456.21));
    point += dot(point, point + 45.32);
    return fract(point.x * point.y);
}

half4 main(float2 fragCoord) {
    float shortest = min(iResolution.x, iResolution.y);
    float2 point = (fragCoord - iResolution * 0.5) / shortest;
    float radius = length(point);
    float angle = atan(point.y, point.x);
    float energy = clamp(iEnergy, 0.0, 1.0);
    float active = step(0.5, iMode);
    float listening = 1.0 - step(0.45, abs(iMode - 2.0));
    float thinking = 1.0 - step(0.45, abs(iMode - 4.0));
    float speaking = 1.0 - step(0.45, abs(iMode - 5.0));
    float fault = 1.0 - step(0.45, abs(iMode - 6.0));
    float breath = 0.5 + 0.5 * sin(iTime * 2.05);

    float nucleus = exp(-radius * (18.0 - energy * 4.0)) * (0.62 + active * 0.38);
    float iris = band(radius, 0.105 + energy * 0.008, 0.009);
    float aperture = band(radius, 0.174 + breath * 0.004, 0.0035);
    float segments = smoothstep(0.28, 0.96, sin(angle * 12.0 - iTime * 0.72) * 0.5 + 0.5);
    float outer = band(radius, 0.292, 0.0028) * segments;
    float counter = band(radius, 0.246, 0.0022) * smoothstep(0.52, 0.96, cos(angle * 8.0 + iTime * 0.9));

    float voiceRadius = 0.145 + energy * 0.027 + sin(angle * 3.0 + iTime * 5.0) * 0.006 * energy;
    float voice = band(radius, voiceRadius, 0.004) * listening;
    float thoughtNodes = pow(max(0.0, cos(angle * 5.0 - iTime * 1.1)), 18.0) *
        band(radius, 0.19 + 0.035 * sin(angle * 2.0 + iTime), 0.012) * thinking;
    float response = band(radius, 0.20 + 0.035 * sin(iTime * 2.6), 0.005) * speaking;
    float fracture = band(abs(point.y + sin(point.x * 48.0 + iTime * 18.0) * 0.008), 0.0, 0.004) *
        (1.0 - smoothstep(0.08, 0.34, abs(point.x))) * fault;

    float rays = pow(max(0.0, sin(angle * 24.0 + iTime * 0.13)), 30.0) *
        (1.0 - smoothstep(0.06, 0.43, radius)) * (0.08 + energy * 0.19);
    float halo = exp(-radius * 7.5) * (0.12 + breath * 0.05 + energy * 0.13);
    float grain = (hash21(floor(fragCoord * 0.45) + floor(iTime * 9.0)) - 0.5) * 0.018;

    float structure = iris * 0.75 + aperture * 0.30 + outer * 0.72 + counter * 0.45;
    float signature = voice * 0.92 + thoughtNodes * 0.85 + response * 0.78 + fracture * 1.25;
    float intensity = nucleus + structure + signature + rays + halo + grain;
    float alpha = clamp(intensity, 0.0, 0.94);
    float3 whiteCore = float3(0.78, 0.94, 1.0) * nucleus * 0.72;
    float3 color = iAccent.rgb * max(0.0, intensity) + whiteCore;
    color += float3(0.18, 0.27, 0.58) * thoughtNodes * 0.42;
    return half4(color.r * alpha, color.g * alpha, color.b * alpha, alpha);
}
"""
