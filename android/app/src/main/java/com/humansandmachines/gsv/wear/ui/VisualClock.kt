package com.humansandmachines.gsv.wear.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import com.humansandmachines.gsv.wear.voice.VoiceTurnState

internal const val ACTIVE_VISUAL_FRAME_INTERVAL_NANOS = 16_666_667L
internal const val AMBIENT_VISUAL_FRAME_INTERVAL_NANOS = 33_333_333L

internal fun assistantFrameIntervalNanos(
    state: VoiceTurnState,
    shapeTarget: OrbShapeTarget,
): Long = if (shapeTarget == OrbShapeTarget.SHIP || state == VoiceTurnState.IDLE) {
    AMBIENT_VISUAL_FRAME_INTERVAL_NANOS
} else {
    ACTIVE_VISUAL_FRAME_INTERVAL_NANOS
}

@Composable
internal fun rememberVisualLoopFraction(
    durationNanos: Long,
    frameIntervalNanos: Long = AMBIENT_VISUAL_FRAME_INTERVAL_NANOS,
): Float {
    require(durationNanos > 0L)
    require(frameIntervalNanos > 0L)
    val phaseOriginNanos = remember { System.nanoTime() }
    var phase by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(durationNanos, frameIntervalNanos) {
        var renderedTick = -1L
        while (true) {
            val frameTimeNanos = withFrameNanos { it }
            val elapsedNanos = (frameTimeNanos - phaseOriginNanos).coerceAtLeast(0L)
            val tick = elapsedNanos / frameIntervalNanos
            if (tick != renderedTick) {
                phase = (elapsedNanos % durationNanos).toFloat() / durationNanos
                renderedTick = tick
            }
        }
    }
    return phase
}
