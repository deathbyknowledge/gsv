package com.humansandmachines.gsv.wear.ui

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.sin

@Composable
internal fun GsvStarField(
    modifier: Modifier = Modifier,
    horizontalParallax: Float = 0f,
    verticalParallax: Float = 0f,
) {
    val phase = rememberVisualLoopFraction(48_000_000_000L) * PI.toFloat() * 2f
    val stars = remember { createGsvStars() }

    Canvas(modifier) {
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(Color(0x16352E73), Color.Transparent),
                center = Offset(size.width * 0.78f, size.height * 0.24f),
                radius = size.maxDimension * 0.50f,
            ),
            center = Offset(size.width * 0.78f, size.height * 0.24f),
            radius = size.maxDimension * 0.50f,
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(Color(0x0D5D5798), Color.Transparent),
                center = Offset(size.width * 0.08f, size.height * 0.69f),
                radius = size.maxDimension * 0.38f,
            ),
            center = Offset(size.width * 0.08f, size.height * 0.69f),
            radius = size.maxDimension * 0.38f,
        )

        val horizontalShift = horizontalParallax.coerceIn(-1f, 1f) * 12.dp.toPx()
        val verticalShift = verticalParallax.coerceIn(-1f, 1f) * 8.dp.toPx()
        stars.forEach { star ->
            val x = wrapStarCoordinate(
                star.x * size.width + horizontalShift * star.depth,
                size.width,
            )
            val y = wrapStarCoordinate(
                star.y * size.height + verticalShift * star.depth,
                size.height,
            )
            val twinkle = 0.68f + 0.32f *
                (0.5f + 0.5f * sin(phase * star.rate + star.phase))
            val alpha = star.alpha * twinkle
            val color = lerp(WEB_STAR_PURPLE, GsvColor.Accent, star.tint).copy(alpha = alpha)
            val radius = star.radiusDp.dp.toPx()

            drawCircle(color = color, radius = radius, center = Offset(x, y))
            if (star.bright) {
                val arm = radius * 2.7f
                val flare = color.copy(alpha = alpha * 0.56f)
                drawLine(
                    color = flare,
                    start = Offset(x - arm, y),
                    end = Offset(x + arm, y),
                    strokeWidth = 1f,
                )
                drawLine(
                    color = flare,
                    start = Offset(x, y - arm),
                    end = Offset(x, y + arm),
                    strokeWidth = 1f,
                )
            }
        }

        drawRect(
            brush = Brush.radialGradient(
                colors = listOf(Color.Transparent, GsvColor.Void.copy(alpha = 0.32f)),
                center = center,
                radius = size.maxDimension * 0.55f,
            ),
        )
    }
}

private data class GsvStar(
    val x: Float,
    val y: Float,
    val depth: Float,
    val phase: Float,
    val rate: Float,
    val alpha: Float,
    val radiusDp: Float,
    val tint: Float,
    val bright: Boolean,
)

private fun createGsvStars(): List<GsvStar> {
    val random = GsvStarRandom()
    return List(STAR_COUNT) {
        val depth = 0.18f + random.nextFloat() * 0.82f
        GsvStar(
            x = random.nextFloat(),
            y = random.nextFloat(),
            depth = depth,
            phase = random.nextFloat() * PI.toFloat() * 2f,
            rate = 1f + (random.nextFloat() * 3f).toInt(),
            alpha = 0.15f + depth * 0.25f + random.nextFloat() * 0.12f,
            radiusDp = 0.27f + depth * 0.50f + random.nextFloat() * 0.15f,
            tint = random.nextFloat() * 0.72f,
            bright = random.nextFloat() > 0.955f,
        )
    }
}

private fun wrapStarCoordinate(value: Float, extent: Float): Float {
    if (extent <= 0f) return 0f
    val wrapped = value % extent
    return if (wrapped < 0f) wrapped + extent else wrapped
}

private class GsvStarRandom {
    private var state = 137L

    fun nextFloat(): Float {
        state = (state * 1_664_525L + 1_013_904_223L) and 0xFFFF_FFFFL
        return (state / 4_294_967_296.0).toFloat()
    }
}

private val WEB_STAR_PURPLE = Color(0xFF5D5798)
private const val STAR_COUNT = 196
