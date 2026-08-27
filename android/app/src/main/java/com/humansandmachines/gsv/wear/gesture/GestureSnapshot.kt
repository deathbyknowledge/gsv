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
    val commitSequence: Long = 0,
    val lastCommit: MindGestureIntent? = null,
)

internal data class GestureCommand(
    val intent: MindGestureIntent,
    val voiceRequestId: Long?,
)
