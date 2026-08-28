package com.humansandmachines.gsv.wear.gesture

import com.humansandmachines.gsv.wear.voice.AssistantSnapshot
import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import java.io.Closeable
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

internal class NativeGestureEngine private constructor(
    private val handle: Long,
) : Closeable {
    private val closed = AtomicBoolean(false)

    fun process(
        buffer: ByteBuffer,
        width: Int,
        height: Int,
        rowStride: Int,
        pixelStride: Int,
        rotationDegrees: Int,
        sequence: Long,
        timestampNanos: Long,
        assistant: AssistantSnapshot,
        stateRevision: Long,
    ): NativeGestureResult {
        if (closed.get() || handle == 0L || !buffer.isDirect) return NativeGestureResult.error()
        val active = assistant.turn != VoiceTurnState.IDLE
        val packed = nativeProcess(
            handle = handle,
            buffer = buffer,
            bufferOffset = buffer.position(),
            bufferLength = buffer.remaining(),
            width = width,
            height = height,
            rowStride = rowStride,
            pixelStride = pixelStride,
            rotationDegrees = rotationDegrees,
            sequence = sequence,
            timestampNanos = timestampNanos,
            stateCode = if (active) STATE_ACTIVE else STATE_STANDBY,
            requestId = assistant.turnId,
            muted = false,
            stateRevision = stateRevision,
        )
        val result = NativeGestureResult.decode(packed)
        if (result.event.requiresVoiceRequest) {
            return result.copy(voiceRequestId = nativeLastIntentRequestId(handle))
        }
        return result
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) nativeDestroy(handle)
    }

    companion object {
        private const val STATE_STANDBY = 0
        private const val STATE_ACTIVE = 1

        init {
            System.loadLibrary("gesture_android")
        }

        fun create(palmModel: ByteArray, landmarkModel: ByteArray): NativeGestureEngine {
            val handle = nativeCreate(palmModel, landmarkModel)
            check(handle != 0L) { "Native gesture models could not be loaded" }
            return NativeGestureEngine(handle)
        }

        @JvmStatic
        private external fun nativeCreate(palmModel: ByteArray, landmarkModel: ByteArray): Long

        @JvmStatic
        private external fun nativeDestroy(handle: Long)

        @JvmStatic
        @Suppress("LongParameterList")
        private external fun nativeProcess(
            handle: Long,
            buffer: ByteBuffer,
            bufferOffset: Int,
            bufferLength: Int,
            width: Int,
            height: Int,
            rowStride: Int,
            pixelStride: Int,
            rotationDegrees: Int,
            sequence: Long,
            timestampNanos: Long,
            stateCode: Int,
            requestId: Long,
            muted: Boolean,
            stateRevision: Long,
        ): Long

        @JvmStatic
        private external fun nativeLastIntentRequestId(handle: Long): Long
    }
}

internal enum class NativeGestureEvent(val requiresVoiceRequest: Boolean = false) {
    NONE,
    START,
    STOP(requiresVoiceRequest = true),
    SEND(requiresVoiceRequest = true),
    UNSUPPORTED,
    ;
}

internal enum class NativeGestureChord(val code: Int) {
    NONE(0),
    ARM(1),
    DISARM(2),
    START(3),
    STOP(4),
    SEND(5),
    DELETE_BACKWARD(6),
    CLEAR(7),
    MUTE(8),
    UNMUTE(9),
    SCROLL(10),
    UNKNOWN(-1),
    ;

    val isCandidate: Boolean
        get() = this != NONE && this != UNKNOWN

    companion object {
        fun decode(code: Int): NativeGestureChord = when (code) {
            0 -> NONE
            1 -> ARM
            2 -> DISARM
            3 -> START
            4 -> STOP
            5 -> SEND
            6 -> DELETE_BACKWARD
            7 -> CLEAR
            8 -> MUTE
            9 -> UNMUTE
            10 -> SCROLL
            else -> UNKNOWN
        }
    }
}

internal data class NativeGestureResult(
    val failed: Boolean,
    val event: NativeGestureEvent,
    val chord: NativeGestureChord,
    val progress: Float,
    val handCount: Int,
    val inferenceMillis: Int,
    val voiceRequestId: Long? = null,
) {
    companion object {
        private const val ERROR_FLAG = Long.MIN_VALUE

        fun decode(packed: Long): NativeGestureResult {
            if (packed and ERROR_FLAG != 0L) return error()
            val event = when ((packed and 0x0f).toInt()) {
                1 -> NativeGestureEvent.START
                2 -> NativeGestureEvent.STOP
                3 -> NativeGestureEvent.SEND
                in 4..8 -> NativeGestureEvent.UNSUPPORTED
                else -> NativeGestureEvent.NONE
            }
            return NativeGestureResult(
                failed = false,
                event = event,
                chord = NativeGestureChord.decode(((packed ushr 4) and 0x0f).toInt()),
                progress = ((packed ushr 8) and 0x03ff).toFloat().div(1_000f).coerceIn(0f, 1f),
                handCount = ((packed ushr 18) and 0x03).toInt(),
                inferenceMillis = ((packed ushr 20) and 0x0fff).toInt(),
            )
        }

        fun error() = NativeGestureResult(
            failed = true,
            event = NativeGestureEvent.NONE,
            chord = NativeGestureChord.NONE,
            progress = 0f,
            handCount = 0,
            inferenceMillis = 0,
        )
    }
}
