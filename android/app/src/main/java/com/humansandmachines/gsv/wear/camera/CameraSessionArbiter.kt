package com.humansandmachines.gsv.wear.camera

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Arbitrates the one physical camera boundary shared by a visible local
 * analysis session and explicit machine-driver captures.
 */
internal object CameraSessionArbiter {
    private val exclusiveMutex = Mutex()
    private val stateLock = Any()
    private var foregroundSession: ForegroundCameraSession? = null
    private var exclusive = false

    fun register(session: ForegroundCameraSession): Boolean = synchronized(stateLock) {
        foregroundSession = session
        !exclusive
    }

    fun unregister(session: ForegroundCameraSession) = synchronized(stateLock) {
        if (foregroundSession === session) foregroundSession = null
    }

    suspend fun <T> withExclusiveCamera(block: suspend () -> T): T = exclusiveMutex.withLock {
        val session = synchronized(stateLock) {
            exclusive = true
            foregroundSession
        }
        try {
            session?.pauseForExclusiveUse()
            block()
        } finally {
            val resume = synchronized(stateLock) {
                exclusive = false
                foregroundSession
            }
            withContext(NonCancellable) {
                resume?.resumeAfterExclusiveUse()
            }
        }
    }
}

internal interface ForegroundCameraSession {
    suspend fun pauseForExclusiveUse()

    suspend fun resumeAfterExclusiveUse()
}
