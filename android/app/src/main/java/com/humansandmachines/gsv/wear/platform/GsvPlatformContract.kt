package com.humansandmachines.gsv.wear.platform

object GsvPlatformContract {
    const val PACKAGE_NAME = "com.humansandmachines.gsv.platform"
    const val SERVICE_CLASS_NAME = "$PACKAGE_NAME.GsvPlatformService"
    const val SERVICE_ACTION = "$PACKAGE_NAME.BIND"
    const val BIND_PERMISSION = "com.humansandmachines.gsv.permission.BIND_PLATFORM_SERVICE"

    const val MIN_API_VERSION = 1
    const val MAX_API_VERSION = 1

    fun supportsApiVersion(version: Int): Boolean = version in MIN_API_VERSION..MAX_API_VERSION
}

data class GsvPlatformStatus(
    val apiVersion: Int,
    val serviceVersion: String,
    val startedElapsedRealtimeMillis: Long,
)
