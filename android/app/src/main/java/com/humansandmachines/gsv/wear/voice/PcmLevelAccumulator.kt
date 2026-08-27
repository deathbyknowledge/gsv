package com.humansandmachines.gsv.wear.voice

import android.media.AudioFormat
import com.humansandmachines.gsv.wear.audio.normalizeVoiceLevel
import kotlin.math.sqrt

internal const val SPEECH_LEVEL_INTERVAL_MILLIS = 40L

internal class PcmLevelAccumulator private constructor(
    private val bytesPerSample: Int,
    private val samplesPerWindow: Int,
    private val decode: (ByteArray, Int) -> Double,
) {
    private var carry = byteArrayOf()
    private var squareSum = 0.0
    private var sampleCount = 0
    private var finished = false

    fun append(chunk: ByteArray): List<Float> {
        if (finished || chunk.isEmpty()) return emptyList()
        val bytes = if (carry.isEmpty()) {
            chunk
        } else {
            ByteArray(carry.size + chunk.size).also { combined ->
                carry.copyInto(combined)
                chunk.copyInto(combined, carry.size)
            }
        }
        val completeBytes = bytes.size - bytes.size % bytesPerSample
        carry = bytes.copyOfRange(completeBytes, bytes.size)
        val levels = mutableListOf<Float>()
        var offset = 0
        while (offset < completeBytes) {
            val sample = decode(bytes, offset)
            squareSum += sample * sample
            sampleCount += 1
            if (sampleCount == samplesPerWindow) {
                levels += currentLevel()
                squareSum = 0.0
                sampleCount = 0
            }
            offset += bytesPerSample
        }
        return levels
    }

    fun finish(): Float? {
        if (finished) return null
        finished = true
        return if (sampleCount > 0) currentLevel() else null
    }

    private fun currentLevel(): Float = normalizeVoiceLevel(sqrt(squareSum / sampleCount))

    companion object {
        fun create(sampleRate: Int, encoding: Int, channelCount: Int): PcmLevelAccumulator? {
            if (sampleRate <= 0 || channelCount !in 1..2) return null
            val samplesPerWindow = (
                sampleRate.toLong() * channelCount * SPEECH_LEVEL_INTERVAL_MILLIS / 1_000
            ).coerceAtLeast(1).toInt()
            return when (encoding) {
                AudioFormat.ENCODING_PCM_8BIT -> PcmLevelAccumulator(1, samplesPerWindow) { bytes, offset ->
                    ((bytes[offset].toInt() and 0xff) - 128) / 128.0
                }
                AudioFormat.ENCODING_PCM_16BIT -> PcmLevelAccumulator(2, samplesPerWindow) { bytes, offset ->
                    val low = bytes[offset].toInt() and 0xff
                    val high = bytes[offset + 1].toInt()
                    ((high shl 8) or low).toShort() / 32768.0
                }
                AudioFormat.ENCODING_PCM_FLOAT -> PcmLevelAccumulator(4, samplesPerWindow) { bytes, offset ->
                    val bits = (bytes[offset].toInt() and 0xff) or
                        ((bytes[offset + 1].toInt() and 0xff) shl 8) or
                        ((bytes[offset + 2].toInt() and 0xff) shl 16) or
                        (bytes[offset + 3].toInt() shl 24)
                    Float.fromBits(bits)
                        .takeIf(Float::isFinite)
                        ?.coerceIn(-1f, 1f)
                        ?.toDouble()
                        ?: 0.0
                }
                else -> null
            }
        }
    }
}
