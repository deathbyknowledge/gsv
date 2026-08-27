package com.humansandmachines.gsv.wear.voice

import android.media.AudioFormat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PcmLevelAccumulatorTest {
    @Test
    fun preservesPcm16SamplesAcrossCallbackBoundaries() {
        val meter = requireNotNull(
            PcmLevelAccumulator.create(
                sampleRate = 1_000,
                encoding = AudioFormat.ENCODING_PCM_16BIT,
                channelCount = 1,
            ),
        )
        val bytes = pcm16(Short.MAX_VALUE, sampleCount = 80)

        assertEquals(emptyList<Float>(), meter.append(bytes.copyOfRange(0, 1)))
        val levels = meter.append(bytes.copyOfRange(1, bytes.size))

        assertEquals(2, levels.size)
        assertEquals(1f, levels[0])
        assertEquals(1f, levels[1])
        assertNull(meter.finish())
    }

    @Test
    fun flushesAQuietPartialWindow() {
        val meter = requireNotNull(
            PcmLevelAccumulator.create(
                sampleRate = 1_000,
                encoding = AudioFormat.ENCODING_PCM_16BIT,
                channelCount = 1,
            ),
        )

        assertEquals(emptyList<Float>(), meter.append(pcm16(0, sampleCount = 20)))
        assertEquals(0f, meter.finish())
        assertNull(meter.finish())
    }

    @Test
    fun rejectsUnsupportedPcmMetadata() {
        assertNull(PcmLevelAccumulator.create(0, AudioFormat.ENCODING_PCM_16BIT, 1))
        assertNull(PcmLevelAccumulator.create(16_000, AudioFormat.ENCODING_PCM_16BIT, 3))
        assertNull(PcmLevelAccumulator.create(16_000, AudioFormat.ENCODING_INVALID, 1))
    }

    private fun pcm16(value: Short, sampleCount: Int): ByteArray =
        ByteArray(sampleCount * 2).also { bytes ->
            repeat(sampleCount) { index ->
                bytes[index * 2] = (value.toInt() and 0xff).toByte()
                bytes[index * 2 + 1] = (value.toInt() shr 8).toByte()
            }
        }
}
