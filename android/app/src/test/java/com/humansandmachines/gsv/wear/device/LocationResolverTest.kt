package com.humansandmachines.gsv.wear.device

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationResolverTest {
    @Test
    fun waitsForGpsAndChoosesTheMoreAccurateCurrentValue() = runBlocking {
        var gpsCompleted = false

        val result = resolveProviderValue(
            providers = listOf("network", "gps"),
            timeoutMillis = 500,
            maxAgeMillis = 60_000,
            requirePostRequestFix = false,
            allowCachedFallback = false,
            nowElapsedRealtimeMillis = { 100_000 },
            current = { provider ->
                if (provider == "network") {
                    value(provider, "network-fix", fixMillis = 99_990, accuracyMeters = 100f)
                } else {
                    delay(25)
                    gpsCompleted = true
                    value(provider, "gps-fix", fixMillis = 99_980, accuracyMeters = 5f)
                }
            },
            lastKnown = { null },
        )

        assertEquals("gps", result.provider)
        assertEquals("gps-fix", result.value)
        assertTrue(gpsCompleted)
        assertFalse(result.cacheFallback)
    }

    @Test
    fun returnsAValidNetworkFixWhenGpsFails() = runBlocking {
        val result = resolveProviderValue(
            providers = listOf("network", "gps"),
            timeoutMillis = 500,
            maxAgeMillis = 60_000,
            requirePostRequestFix = false,
            allowCachedFallback = false,
            nowElapsedRealtimeMillis = { 100_000 },
            current = { provider ->
                if (provider == "gps") error("no satellite fix")
                value(provider, "network-fix", fixMillis = 99_900, accuracyMeters = 100f)
            },
            lastKnown = { null },
        )

        assertEquals("network", result.provider)
    }

    @Test
    fun rejectsStaleCurrentValues() = runBlocking {
        val failure = runCatching {
            resolveProviderValue(
                providers = listOf("network", "gps"),
                timeoutMillis = 500,
                maxAgeMillis = 10_000,
                requirePostRequestFix = false,
                allowCachedFallback = false,
                nowElapsedRealtimeMillis = { 100_000 },
                current = { provider ->
                    value(provider, "stale", fixMillis = 1_000, accuracyMeters = 5f)
                },
                lastKnown = { null },
            )
        }.exceptionOrNull()

        assertTrue(failure is ProviderResolutionTimeout)
    }

    @Test
    fun forcedRequestsRejectPreRequestFixesEvenWhenTheyAreRecent() = runBlocking {
        val failure = runCatching {
            resolveProviderValue(
                providers = listOf("gps"),
                timeoutMillis = 500,
                maxAgeMillis = 10_000,
                requirePostRequestFix = true,
                allowCachedFallback = false,
                nowElapsedRealtimeMillis = { 100_000 },
                current = { provider ->
                    value(
                        provider,
                        "recent-cache",
                        fixMillis = 99_999,
                        accuracyMeters = 5f,
                        generatedAfterRequest = false,
                    )
                },
                lastKnown = { null },
            )
        }.exceptionOrNull()

        assertTrue(failure is ProviderResolutionTimeout)
    }

    @Test
    fun usesTheFreshestEligibleCacheOnlyWhenExplicitlyAllowed() = runBlocking {
        val result = resolveProviderValue(
            providers = listOf("network", "gps"),
            timeoutMillis = 25,
            maxAgeMillis = 60_000,
            requirePostRequestFix = false,
            allowCachedFallback = true,
            nowElapsedRealtimeMillis = { 100_000 },
            current = {
                delay(1_000)
                error("late")
            },
            lastKnown = { provider ->
                if (provider == "network") {
                    value(provider, "network-cache", fixMillis = 99_000, accuracyMeters = 100f, cache = true)
                } else {
                    value(provider, "gps-cache", fixMillis = 95_000, accuracyMeters = 5f, cache = true)
                }
            },
        )

        assertEquals("network", result.provider)
        assertEquals("network-cache", result.value)
        assertTrue(result.cacheFallback)
        assertEquals(1_000, result.ageMillis(100_000))
    }

    @Test
    fun doesNotUseAnEligibleCacheWithoutTheFallbackFlag() = runBlocking {
        val failure = runCatching {
            resolveProviderValue(
                providers = listOf("gps"),
                timeoutMillis = 25,
                maxAgeMillis = 60_000,
                requirePostRequestFix = false,
                allowCachedFallback = false,
                nowElapsedRealtimeMillis = { 100_000 },
                current = {
                    delay(1_000)
                    error("late")
                },
                lastKnown = { provider ->
                    value(provider, "gps-cache", fixMillis = 99_000, accuracyMeters = 5f, cache = true)
                },
            )
        }.exceptionOrNull()

        assertTrue(failure is ProviderResolutionTimeout)
    }

    private fun value(
        provider: String,
        value: String,
        fixMillis: Long,
        accuracyMeters: Float,
        generatedAfterRequest: Boolean = true,
        cache: Boolean = false,
    ): ProviderValue<String> = ProviderValue(
        provider = provider,
        value = value,
        fixElapsedRealtimeMillis = fixMillis,
        accuracyMeters = accuracyMeters,
        generatedAfterRequest = generatedAfterRequest,
        cacheFallback = cache,
    )
}
