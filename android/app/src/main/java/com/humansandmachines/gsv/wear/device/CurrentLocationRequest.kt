package com.humansandmachines.gsv.wear.device

enum class LocationProviderPreference(val wireName: String) {
    BEST("best"),
    GPS("gps"),
    NETWORK("network"),
    ;

    companion object {
        fun fromWireName(value: String): LocationProviderPreference? = entries.firstOrNull { it.wireName == value }
    }
}

data class CurrentLocationRequest(
    val timeoutMillis: Long = DEFAULT_TIMEOUT_MILLIS,
    val provider: LocationProviderPreference = LocationProviderPreference.BEST,
    val maxAgeMillis: Long = DEFAULT_MAX_AGE_MILLIS,
    val forceNewFix: Boolean = false,
    val allowCachedFallback: Boolean = false,
) {
    companion object {
        const val DEFAULT_TIMEOUT_MILLIS = 15_000L
        const val DEFAULT_MAX_AGE_MILLIS = 30_000L
        const val MAX_TIMEOUT_MILLIS = 60_000L
        const val MAX_AGE_MILLIS = 5 * 60 * 1_000L
    }
}
