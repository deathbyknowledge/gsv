package com.humansandmachines.gsv.wear.protocol

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BinaryFrameCodecTest {
    @Test
    fun matchesTheGsvLittleEndianWireFormat() {
        val encoded = BinaryFrameCodec.encode(
            streamId = 0x1234_5678L,
            flags = BinaryFrameCodec.DATA,
            payload = byteArrayOf(0x41, 0x42),
        )

        assertArrayEquals(
            byteArrayOf(0x78, 0x56, 0x34, 0x12, 0x01, 0x41, 0x42),
            encoded,
        )
    }

    @Test
    fun decodesUnsignedStreamIds() {
        val encoded = BinaryFrameCodec.encode(
            BinaryFrameCodec.MAX_STREAM_ID,
            BinaryFrameCodec.CANCEL or BinaryFrameCodec.END,
        )

        val decoded = BinaryFrameCodec.decode(encoded)!!
        assertEquals(BinaryFrameCodec.MAX_STREAM_ID, decoded.streamId)
        assertEquals(BinaryFrameCodec.CANCEL or BinaryFrameCodec.END, decoded.flags)
    }

    @Test
    fun rejectsTruncatedAndZeroStreamFrames() {
        assertNull(BinaryFrameCodec.decode(byteArrayOf(1, 2, 3, 4)))
        assertNull(BinaryFrameCodec.decode(byteArrayOf(0, 0, 0, 0, 1)))
    }
}
