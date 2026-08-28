package com.humansandmachines.gsv.wear.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.withInfiniteAnimationFrameNanos
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

@Composable
internal fun GsvStarField(
    modifier: Modifier = Modifier,
    horizontalParallax: Float = 0f,
    verticalParallax: Float = 0f,
    shipOrbitRadians: Float = 0f,
    shipElevationOffsetRadians: Float = 0f,
    propulsionActive: Boolean = false,
) {
    val propulsion by animateFloatAsState(
        targetValue = if (propulsionActive) 1f else 0f,
        animationSpec = tween(
            durationMillis = if (propulsionActive) {
                STAR_PROPULSION_IGNITION_MILLIS
            } else {
                STAR_PROPULSION_SHUTDOWN_MILLIS
            },
            easing = FastOutSlowInEasing,
        ),
        label = "star-propulsion",
    )
    val motion = rememberStarFieldMotion(propulsion)
    val stars = remember { createGsvStars() }
    val travelDirection = shipTailScreenDirection(
        orbitRadians = shipOrbitRadians,
        elevationOffsetRadians = shipElevationOffsetRadians,
    )

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
            val cruiseDistance = motion.travel * size.minDimension *
                (0.22f + star.depth * 0.78f)
            val x = wrapStarCoordinate(
                star.x * size.width + horizontalShift * star.depth +
                    travelDirection.x * cruiseDistance,
                size.width,
            )
            val y = wrapStarCoordinate(
                star.y * size.height + verticalShift * star.depth +
                    travelDirection.y * cruiseDistance,
                size.height,
            )
            val twinkle = 0.68f + 0.32f *
                (0.5f + 0.5f * sin(motion.phase * star.rate + star.phase))
            val alpha = (star.alpha * twinkle * (1f + propulsion * 0.10f))
                .coerceAtMost(1f)
            val color = lerp(WEB_STAR_PURPLE, GsvColor.Accent, star.tint).copy(alpha = alpha)
            val radius = star.radiusDp.dp.toPx() * (1f + propulsion * star.depth * 0.06f)

            if (propulsion > 0.001f) {
                val streakLength = (1.1f + star.depth * 4.8f).dp.toPx() * propulsion
                drawLine(
                    color = color.copy(alpha = alpha * propulsion * 0.32f),
                    start = Offset(
                        x - travelDirection.x * streakLength,
                        y - travelDirection.y * streakLength,
                    ),
                    end = Offset(x, y),
                    strokeWidth = (0.34f + star.depth * 0.36f).dp.toPx(),
                )
            }

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

@Composable
private fun rememberStarFieldMotion(propulsion: Float): GsvStarMotion {
    val phaseOriginNanos = remember { System.nanoTime() }
    val currentPropulsion by rememberUpdatedState(propulsion)
    var motion by remember { mutableStateOf(GsvStarMotion()) }
    LaunchedEffect(Unit) {
        var previousFrameNanos = 0L
        var renderedTick = -1L
        while (true) {
            val frameTimeNanos = withInfiniteAnimationFrameNanos { it }
            val tick = frameTimeNanos / AMBIENT_VISUAL_FRAME_INTERVAL_NANOS
            if (tick == renderedTick) continue

            val elapsedNanos = (frameTimeNanos - phaseOriginNanos).coerceAtLeast(0L)
            val deltaSeconds = if (previousFrameNanos == 0L) {
                0f
            } else {
                ((frameTimeNanos - previousFrameNanos).coerceIn(0L, 100_000_000L) /
                    1_000_000_000f)
            }
            motion = GsvStarMotion(
                phase = (elapsedNanos % STAR_TWINKLE_LOOP_NANOS).toFloat() /
                    STAR_TWINKLE_LOOP_NANOS * PI.toFloat() * 2f,
                travel = motion.travel + deltaSeconds * currentPropulsion *
                    STAR_CRUISE_SCREEN_LENGTHS_PER_SECOND,
            )
            previousFrameNanos = frameTimeNanos
            renderedTick = tick
        }
    }
    return motion
}

private data class GsvStarMotion(
    val phase: Float = 0f,
    val travel: Float = 0f,
)

private fun shipTailScreenDirection(
    orbitRadians: Float,
    elevationOffsetRadians: Float,
): Offset {
    val heading = 1.355f
    val sideAngle = 0.300f
    val elevationAngle = -0.833f
    var cameraAxis = ShipDirection(0f, 0f, 1f)
        .rotateXy(heading)
        .rotateYz(sideAngle)
        .rotateXz(elevationAngle)
        .rotateXy(orbitRadians)
    cameraAxis = cameraAxis.normalized()
    val elevationAxis = ShipDirection(-cameraAxis.y, cameraAxis.x, 0f).normalized()
    val tail = ShipDirection(0f, 1f, 0f)
        .rotateAround(elevationAxis, elevationOffsetRadians)
        .rotateXy(-orbitRadians)
        .rotateXz(-elevationAngle)
        .rotateYz(-sideAngle)
        .rotateXy(-heading)
    val screenLength = sqrt(tail.x * tail.x + tail.y * tail.y)
    return if (screenLength < 0.0001f) {
        Offset(1f, 0f)
    } else {
        Offset(tail.x / screenLength, -tail.y / screenLength)
    }
}

private data class ShipDirection(
    val x: Float,
    val y: Float,
    val z: Float,
) {
    fun rotateXy(angle: Float): ShipDirection {
        val sine = sin(angle)
        val cosine = cos(angle)
        return copy(
            x = cosine * x - sine * y,
            y = sine * x + cosine * y,
        )
    }

    fun rotateYz(angle: Float): ShipDirection {
        val sine = sin(angle)
        val cosine = cos(angle)
        return copy(
            y = cosine * y - sine * z,
            z = sine * y + cosine * z,
        )
    }

    fun rotateXz(angle: Float): ShipDirection {
        val sine = sin(angle)
        val cosine = cos(angle)
        return copy(
            x = cosine * x - sine * z,
            z = sine * x + cosine * z,
        )
    }

    fun rotateAround(axis: ShipDirection, angle: Float): ShipDirection {
        val sine = sin(angle)
        val cosine = cos(angle)
        val crossX = axis.y * z - axis.z * y
        val crossY = axis.z * x - axis.x * z
        val crossZ = axis.x * y - axis.y * x
        val projection = axis.x * x + axis.y * y + axis.z * z
        val axisScale = projection * (1f - cosine)
        return ShipDirection(
            x = x * cosine + crossX * sine + axis.x * axisScale,
            y = y * cosine + crossY * sine + axis.y * axisScale,
            z = z * cosine + crossZ * sine + axis.z * axisScale,
        )
    }

    fun normalized(): ShipDirection {
        val length = sqrt(x * x + y * y + z * z)
        return if (length < 0.0001f) this else ShipDirection(x / length, y / length, z / length)
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
private const val STAR_TWINKLE_LOOP_NANOS = 48_000_000_000L
private const val STAR_CRUISE_SCREEN_LENGTHS_PER_SECOND = 0.052f
private const val STAR_PROPULSION_IGNITION_MILLIS = 1_250
private const val STAR_PROPULSION_SHUTDOWN_MILLIS = 900
