package com.humansandmachines.gsv.wear.audio

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal enum class MicrophoneCapturePriority(
    val rank: Int,
    val preemptsEqual: Boolean,
) {
    DRIVER(rank = 0, preemptsEqual = false),
    ASSISTANT(rank = 1, preemptsEqual = true),
}

internal object MicrophoneCaptureArbiter {
    private val mutex = Mutex()
    private val stateLock = Any()
    private var active: ActiveCapture? = null

    suspend fun <T> capture(
        priority: MicrophoneCapturePriority,
        block: suspend () -> T,
    ): T {
        val requester = currentCoroutineContext()[Job]
            ?: error("Microphone capture requires a coroutine job")
        val activeToPreempt = synchronized(stateLock) {
            active?.takeIf { current ->
                priority.rank > current.priority.rank ||
                    priority.rank == current.priority.rank && priority.preemptsEqual
            }?.job
        }
        activeToPreempt?.cancel(CancellationException("Microphone capture was superseded"))

        return mutex.withLock {
            currentCoroutineContext().ensureActive()
            synchronized(stateLock) {
                active = ActiveCapture(requester, priority)
            }
            try {
                block()
            } finally {
                synchronized(stateLock) {
                    if (active?.job === requester) active = null
                }
            }
        }
    }

    private data class ActiveCapture(
        val job: Job,
        val priority: MicrophoneCapturePriority,
    )
}
