package com.humansandmachines.gsv.wear.connection

import kotlin.math.min
import kotlin.random.Random

fun interface JitterSource {
    fun nextLong(untilExclusive: Long): Long
}

class ReconnectPolicy(
    private val initialDelayMillis: Long = 1_000,
    private val maximumDelayMillis: Long = 60_000,
    private val jitter: JitterSource = JitterSource { Random.nextLong(it) },
) {
    private var attempt = 0

    init {
        require(initialDelayMillis > 0)
        require(maximumDelayMillis >= initialDelayMillis)
    }

    fun nextDelayMillis(): Long {
        var ceiling = initialDelayMillis
        repeat(min(attempt, 62)) {
            ceiling = min(maximumDelayMillis, ceiling * 2)
        }
        attempt += 1
        return jitter.nextLong(ceiling + 1)
    }

    fun reset() {
        attempt = 0
    }
}
