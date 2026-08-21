package com.humansandmachines.gsv.wear.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder

data class BinaryFrame(
    val streamId: Long,
    val flags: Int,
    val payload: ByteArray,
)

object BinaryFrameCodec {
    const val HEADER_BYTES = 5
    const val DATA = 1 shl 0
    const val END = 1 shl 1
    const val ERROR = 1 shl 2
    const val CANCEL = 1 shl 3
    const val MAX_STREAM_ID = 0xffff_ffffL

    fun encode(streamId: Long, flags: Int, payload: ByteArray = byteArrayOf()): ByteArray {
        require(streamId in 1..MAX_STREAM_ID) { "Invalid binary stream id" }
        return ByteBuffer.allocate(HEADER_BYTES + payload.size)
            .order(ByteOrder.LITTLE_ENDIAN)
            .putInt(streamId.toInt())
            .put((flags and 0xff).toByte())
            .put(payload)
            .array()
    }

    fun decode(bytes: ByteArray): BinaryFrame? {
        if (bytes.size < HEADER_BYTES) return null
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val streamId = Integer.toUnsignedLong(buffer.int)
        if (streamId == 0L) return null
        val flags = buffer.get().toInt() and 0xff
        val payload = ByteArray(buffer.remaining())
        buffer.get(payload)
        return BinaryFrame(streamId, flags, payload)
    }
}
