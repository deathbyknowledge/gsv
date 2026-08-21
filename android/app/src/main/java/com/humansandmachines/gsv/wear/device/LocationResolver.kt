package com.humansandmachines.gsv.wear.device

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withTimeoutOrNull

internal data class ProviderValue<T>(
    val provider: String,
    val value: T,
    val fixElapsedRealtimeMillis: Long,
    val accuracyMeters: Float,
    val generatedAfterRequest: Boolean,
    val cacheFallback: Boolean = false,
) {
    fun ageMillis(nowElapsedRealtimeMillis: Long): Long =
        (nowElapsedRealtimeMillis - fixElapsedRealtimeMillis).coerceAtLeast(0L)
}

internal class ProviderResolutionTimeout : Exception()

internal suspend fun <T> resolveProviderValue(
    providers: List<String>,
    timeoutMillis: Long,
    maxAgeMillis: Long,
    requirePostRequestFix: Boolean,
    allowCachedFallback: Boolean,
    nowElapsedRealtimeMillis: () -> Long,
    current: suspend (String) -> ProviderValue<T>,
    lastKnown: (String) -> ProviderValue<T>?,
): ProviderValue<T> {
    require(providers.isNotEmpty())
    var firstFailure: Throwable? = null
    val currentValues = mutableListOf<ProviderValue<T>>()
    withTimeoutOrNull(timeoutMillis) {
        supervisorScope {
            val results = Channel<Result<ProviderValue<T>>>(providers.size)
            val jobs = providers.map { provider ->
                launch {
                    val result = try {
                        Result.success(current(provider))
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: Throwable) {
                        Result.failure(error)
                    }
                    results.send(result)
                }
            }
            try {
                repeat(providers.size) {
                    val attempt = results.receive()
                    attempt.getOrNull()?.let(currentValues::add)
                    if (firstFailure == null) firstFailure = attempt.exceptionOrNull()
                }
            } finally {
                jobs.forEach { it.cancel() }
                results.cancel()
            }
        }
    }
    val now = nowElapsedRealtimeMillis()
    currentValues
        .filter { value -> value.isEligible(now, maxAgeMillis, requirePostRequestFix) }
        .minWithOrNull(
            compareBy<ProviderValue<T>> { it.accuracyMeters }
                .thenBy { it.ageMillis(now) }
                .thenBy { if (it.provider == "gps") 0 else 1 },
        )
        ?.let { return it }

    if (allowCachedFallback) {
        providers
            .mapNotNull(lastKnown)
            .filter { value -> value.isEligible(now, maxAgeMillis, requirePostRequestFix = false) }
            .minWithOrNull(
                compareBy<ProviderValue<T>> { it.ageMillis(now) }
                    .thenBy { it.accuracyMeters }
                    .thenBy { if (it.provider == "gps") 0 else 1 },
            )
            ?.let { return it }
    }

    firstFailure?.let { throw it }
    throw ProviderResolutionTimeout()
}

private fun <T> ProviderValue<T>.isEligible(
    nowElapsedRealtimeMillis: Long,
    maxAgeMillis: Long,
    requirePostRequestFix: Boolean,
): Boolean = ageMillis(nowElapsedRealtimeMillis) <= maxAgeMillis &&
    (!requirePostRequestFix || generatedAfterRequest)
