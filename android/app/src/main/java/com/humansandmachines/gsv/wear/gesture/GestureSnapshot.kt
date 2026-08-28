package com.humansandmachines.gsv.wear.gesture

enum class GestureLinkState {
    OFF,
    PREPARING,
    READY,
    TRACKING,
    ERROR,
}

enum class MindGestureIntent {
    START,
    STOP,
    SEND,
}

data class GestureSnapshot(
    val state: GestureLinkState = GestureLinkState.OFF,
    val progress: Float = 0f,
    val candidateSequence: Long = 0,
    val candidateFillDurationMillis: Int = DEFAULT_GESTURE_FILL_MILLIS,
    val commitSequence: Long = 0,
    val lastCommit: MindGestureIntent? = null,
)

internal data class GestureCommand(
    val intent: MindGestureIntent,
    val voiceRequestId: Long?,
)

internal fun gestureCandidateFillDurationMillis(sampleIntervalNanos: Long): Int {
    val measuredMillis = if (sampleIntervalNanos > 0L) {
        ((sampleIntervalNanos + NANOS_PER_MILLISECOND / 2) / NANOS_PER_MILLISECOND).toInt()
    } else {
        DEFAULT_INFERENCE_INTERVAL_MILLIS
    }
    val intervalMillis = measuredMillis.coerceIn(
        MIN_INFERENCE_INTERVAL_MILLIS,
        MAX_INFERENCE_INTERVAL_MILLIS,
    )
    val dwellIntervals = (
        STANDARD_GESTURE_DWELL_MILLIS + intervalMillis - 1
    ) / intervalMillis
    return intervalMillis * maxOf(MINIMUM_MATCH_INTERVALS, dwellIntervals)
}

// Presentation follows the standard engine recipe, but never grants semantic
// completion. The Rust engine remains authoritative for every command.
private const val STANDARD_GESTURE_DWELL_MILLIS = 350
private const val MINIMUM_MATCH_INTERVALS = 3
private const val MIN_INFERENCE_INTERVAL_MILLIS = 80
private const val MAX_INFERENCE_INTERVAL_MILLIS = 250
private const val DEFAULT_INFERENCE_INTERVAL_MILLIS = 120
private const val DEFAULT_GESTURE_FILL_MILLIS = 360
private const val NANOS_PER_MILLISECOND = 1_000_000L
