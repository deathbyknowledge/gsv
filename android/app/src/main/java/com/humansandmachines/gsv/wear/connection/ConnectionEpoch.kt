package com.humansandmachines.gsv.wear.connection

import java.util.concurrent.atomic.AtomicLong

class ConnectionEpoch {
    private val current = AtomicLong(0)

    fun next(): Long = current.incrementAndGet()

    fun invalidate(): Long = current.incrementAndGet()

    fun isCurrent(epoch: Long): Boolean = current.get() == epoch
}
