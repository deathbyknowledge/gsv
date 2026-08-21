package com.humansandmachines.gsv.wear.device

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Looper
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class DeviceContextFailure(message: String) : Exception(message)

interface DeviceContextSource {
    fun status(): JSONObject

    fun battery(): JSONObject

    fun network(): JSONObject

    fun thermal(): JSONObject

    suspend fun currentLocation(request: CurrentLocationRequest): JSONObject
}

class DeviceContextController(private val context: Context) : DeviceContextSource {
    override fun status(): JSONObject = JSONObject()
        .put("platform", "android")
        .put("manufacturer", Build.MANUFACTURER)
        .put("brand", Build.BRAND)
        .put("model", Build.MODEL)
        .put("androidRelease", Build.VERSION.RELEASE)
        .put("sdk", Build.VERSION.SDK_INT)
        .put("supportedAbis", JSONArray(Build.SUPPORTED_ABIS.toList()))
        .put("battery", battery())
        .put("network", network())
        .put("thermal", thermal())
        .put("storage", storage())
        .put(
            "permissions",
            JSONObject()
                .put("camera", hasPermission(Manifest.permission.CAMERA))
                .put("microphone", hasPermission(Manifest.permission.RECORD_AUDIO))
                .put("coarseLocation", hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION))
                .put("fineLocation", hasPermission(Manifest.permission.ACCESS_FINE_LOCATION))
                .put(
                    "notifications",
                    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                        hasPermission(Manifest.permission.POST_NOTIFICATIONS),
                ),
        )

    override fun battery(): JSONObject {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?: throw DeviceContextFailure("Battery state is unavailable")
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
        return JSONObject()
            .put("levelPercent", if (level >= 0 && scale > 0) level * 100.0 / scale else JSONObject.NULL)
            .put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING)
            .put("full", status == BatteryManager.BATTERY_STATUS_FULL)
            .put("powerSource", powerSource(plugged))
            .put("temperatureCelsius", intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0)
            .put("voltageMillivolts", intent.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0))
            .put("health", batteryHealth(intent.getIntExtra(BatteryManager.EXTRA_HEALTH, 0)))
    }

    override fun network(): JSONObject {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val active = manager.activeNetwork
        val capabilities = active?.let(manager::getNetworkCapabilities)
        if (capabilities == null) return JSONObject().put("connected", false)
        val transports = JSONArray()
        val transportTypes = mutableListOf(
            NetworkCapabilities.TRANSPORT_WIFI to "wifi",
            NetworkCapabilities.TRANSPORT_CELLULAR to "cellular",
            NetworkCapabilities.TRANSPORT_ETHERNET to "ethernet",
            NetworkCapabilities.TRANSPORT_BLUETOOTH to "bluetooth",
            NetworkCapabilities.TRANSPORT_VPN to "vpn",
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            transportTypes += NetworkCapabilities.TRANSPORT_USB to "usb"
        }
        transportTypes.forEach { (transport, label) ->
            if (capabilities.hasTransport(transport)) transports.put(label)
        }
        return JSONObject()
            .put("connected", true)
            .put("transports", transports)
            .put("internet", capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
            .put("validated", capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
            .put("metered", !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
            .put(
                "roaming",
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING)
                } else {
                    JSONObject.NULL
                },
            )
            .put("downstreamKbps", capabilities.linkDownstreamBandwidthKbps)
            .put("upstreamKbps", capabilities.linkUpstreamBandwidthKbps)
    }

    override fun thermal(): JSONObject {
        val manager = context.getSystemService(PowerManager::class.java)
        val currentStatus = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            manager.currentThermalStatus
        } else {
            -1
        }
        return JSONObject()
            .put("status", thermalStatus(currentStatus))
            .put("statusCode", currentStatus)
            .put("powerSaveMode", manager.isPowerSaveMode)
            .put("interactive", manager.isInteractive)
    }

    override suspend fun currentLocation(request: CurrentLocationRequest): JSONObject {
        if (request.timeoutMillis !in 1_000L..CurrentLocationRequest.MAX_TIMEOUT_MILLIS) {
            throw DeviceContextFailure("Location timeout must be between 1000 and 60000 ms")
        }
        if (request.maxAgeMillis !in 0L..CurrentLocationRequest.MAX_AGE_MILLIS) {
            throw DeviceContextFailure("Location maximum age must be between 0 and 300000 ms")
        }
        if (request.forceNewFix && request.allowCachedFallback) {
            throw DeviceContextFailure("A forced location fix cannot allow cached fallback")
        }
        if (!hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)) {
            throw DeviceContextFailure("Location permission is unavailable")
        }
        val manager = context.getSystemService(LocationManager::class.java)
        val providers = when (request.provider) {
            LocationProviderPreference.BEST -> buildList {
                if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    add(LocationManager.NETWORK_PROVIDER)
                }
                if (manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    add(LocationManager.GPS_PROVIDER)
                }
            }
            LocationProviderPreference.GPS -> enabledProvider(manager, LocationManager.GPS_PROVIDER)
            LocationProviderPreference.NETWORK -> enabledProvider(manager, LocationManager.NETWORK_PROVIDER)
        }
        if (providers.isEmpty()) throw DeviceContextFailure("Location services are disabled")
        val requestStartedElapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
        val resolved = try {
            resolveProviderValue(
                providers = providers,
                timeoutMillis = request.timeoutMillis,
                maxAgeMillis = request.maxAgeMillis,
                requirePostRequestFix = request.forceNewFix,
                allowCachedFallback = request.allowCachedFallback,
                nowElapsedRealtimeMillis = SystemClock::elapsedRealtime,
                current = { provider ->
                    val location = if (request.forceNewFix) {
                        manager.awaitNewLocation(provider, requestStartedElapsedRealtimeNanos)
                    } else {
                        manager.awaitCurrentLocation(provider)
                    }
                    location.toProviderValue(
                        provider = provider,
                        requestStartedElapsedRealtimeNanos = requestStartedElapsedRealtimeNanos,
                        cacheFallback = false,
                    )
                },
                lastKnown = { provider ->
                    manager.getLastKnownLocation(provider)?.let { location ->
                        location.toProviderValue(
                            provider = provider,
                            requestStartedElapsedRealtimeNanos = requestStartedElapsedRealtimeNanos,
                            cacheFallback = true,
                        )
                    }
                },
            )
        } catch (_: ProviderResolutionTimeout) {
            throw DeviceContextFailure("No location fix met the requested freshness")
        } catch (_: SecurityException) {
            throw DeviceContextFailure("Location permission is unavailable")
        }
        val ageMillis = resolved.ageMillis(SystemClock.elapsedRealtime())
        if (ageMillis > request.maxAgeMillis) {
            throw DeviceContextFailure("No location fix met the requested freshness")
        }
        return resolved.value.toJson(
            provider = resolved.provider,
            requestedProvider = request.provider,
            ageMillis = ageMillis,
            maxAgeMillis = request.maxAgeMillis,
            cacheFallback = resolved.cacheFallback,
            generatedAfterRequest = resolved.generatedAfterRequest,
            forced = request.forceNewFix,
        )
    }

    private fun enabledProvider(manager: LocationManager, provider: String): List<String> {
        if (!manager.isProviderEnabled(provider)) {
            throw DeviceContextFailure("The requested $provider location provider is disabled")
        }
        return listOf(provider)
    }

    @SuppressLint("MissingPermission")
    @Suppress("DEPRECATION")
    private suspend fun LocationManager.awaitCurrentLocation(provider: String): Location =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            suspendCancellableCoroutine { continuation ->
                val cancellation = CancellationSignal()
                continuation.invokeOnCancellation { cancellation.cancel() }
                try {
                    getCurrentLocation(
                        provider,
                        cancellation,
                        ContextCompat.getMainExecutor(context),
                    ) { location ->
                        if (!continuation.isActive) return@getCurrentLocation
                        if (location == null) {
                            continuation.resumeWithException(DeviceContextFailure("Location is unavailable"))
                        } else {
                            continuation.resume(location)
                        }
                    }
                } catch (error: Exception) {
                    if (continuation.isActive) continuation.resumeWithException(error)
                }
            }
        } else {
            suspendCancellableCoroutine { continuation ->
                val completed = AtomicBoolean(false)
                val listener = object : LocationListener {
                    override fun onLocationChanged(location: Location) {
                        if (completed.compareAndSet(false, true) && continuation.isActive) {
                            continuation.resume(location)
                        }
                    }

                    @Deprecated("Deprecated in Android")
                    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

                    override fun onProviderEnabled(provider: String) = Unit

                    override fun onProviderDisabled(provider: String) = Unit
                }
                continuation.invokeOnCancellation {
                    if (completed.compareAndSet(false, true)) runCatching { removeUpdates(listener) }
                }
                try {
                    requestSingleUpdate(provider, listener, Looper.getMainLooper())
                } catch (error: Exception) {
                    if (completed.compareAndSet(false, true) && continuation.isActive) {
                        continuation.resumeWithException(error)
                    }
                }
            }
        }

    @SuppressLint("MissingPermission")
    @Suppress("DEPRECATION")
    private suspend fun LocationManager.awaitNewLocation(
        provider: String,
        requestStartedElapsedRealtimeNanos: Long,
    ): Location = suspendCancellableCoroutine { continuation ->
        val completed = AtomicBoolean(false)
        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                if (location.elapsedRealtimeNanos < requestStartedElapsedRealtimeNanos) return
                if (completed.compareAndSet(false, true)) {
                    runCatching { removeUpdates(this) }
                    if (continuation.isActive) continuation.resume(location)
                }
            }

            @Deprecated("Deprecated in Android")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

            override fun onProviderEnabled(provider: String) = Unit

            override fun onProviderDisabled(provider: String) {
                if (completed.compareAndSet(false, true)) {
                    runCatching { removeUpdates(this) }
                    if (continuation.isActive) {
                        continuation.resumeWithException(
                            DeviceContextFailure("The requested $provider location provider was disabled"),
                        )
                    }
                }
            }
        }
        continuation.invokeOnCancellation {
            if (completed.compareAndSet(false, true)) runCatching { removeUpdates(listener) }
        }
        try {
            requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper())
        } catch (error: Exception) {
            if (completed.compareAndSet(false, true) && continuation.isActive) {
                continuation.resumeWithException(error)
            }
        }
    }

    private fun storage(): JSONObject {
        val files = StatFs(context.filesDir.absolutePath)
        val cache = StatFs(context.cacheDir.absolutePath)
        return JSONObject()
            .put("persistentAvailableBytes", files.availableBytes)
            .put("persistentTotalBytes", files.totalBytes)
            .put("temporaryAvailableBytes", cache.availableBytes)
            .put("temporaryTotalBytes", cache.totalBytes)
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun Location.toProviderValue(
        provider: String,
        requestStartedElapsedRealtimeNanos: Long,
        cacheFallback: Boolean,
    ): ProviderValue<Location> = ProviderValue(
        provider = provider,
        value = this,
        fixElapsedRealtimeMillis = elapsedRealtimeNanos / NANOS_PER_MILLISECOND,
        accuracyMeters = accuracy,
        generatedAfterRequest = elapsedRealtimeNanos >= requestStartedElapsedRealtimeNanos,
        cacheFallback = cacheFallback,
    )

    private fun Location.toJson(
        provider: String,
        requestedProvider: LocationProviderPreference,
        ageMillis: Long,
        maxAgeMillis: Long,
        cacheFallback: Boolean,
        generatedAfterRequest: Boolean,
        forced: Boolean,
    ): JSONObject = JSONObject()
        .put("provider", provider)
        .put("requestedProvider", requestedProvider.wireName)
        .put("latitude", latitude)
        .put("longitude", longitude)
        .put("accuracyMeters", accuracy)
        .put("ageMillis", ageMillis)
        .put("maxAgeMillis", maxAgeMillis)
        .put("cacheFallback", cacheFallback)
        .put("generatedAfterRequest", generatedAfterRequest)
        .put("forced", forced)
        .put("time", time)
        .put("elapsedRealtimeNanos", elapsedRealtimeNanos)
        .apply { if (hasAltitude()) put("altitudeMeters", altitude) }
        .apply { if (hasBearing()) put("bearingDegrees", bearing) }
        .apply { if (hasSpeed()) put("speedMetersPerSecond", speed) }

    private fun powerSource(value: Int): String = when (value) {
        BatteryManager.BATTERY_PLUGGED_AC -> "ac"
        BatteryManager.BATTERY_PLUGGED_USB -> "usb"
        BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
        BatteryManager.BATTERY_PLUGGED_DOCK -> "dock"
        else -> "battery"
    }

    private fun batteryHealth(value: Int): String = when (value) {
        BatteryManager.BATTERY_HEALTH_GOOD -> "good"
        BatteryManager.BATTERY_HEALTH_OVERHEAT -> "overheat"
        BatteryManager.BATTERY_HEALTH_DEAD -> "dead"
        BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "over_voltage"
        BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE -> "failure"
        BatteryManager.BATTERY_HEALTH_COLD -> "cold"
        else -> "unknown"
    }

    private fun thermalStatus(value: Int): String = when (value) {
        PowerManager.THERMAL_STATUS_NONE -> "none"
        PowerManager.THERMAL_STATUS_LIGHT -> "light"
        PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
        PowerManager.THERMAL_STATUS_SEVERE -> "severe"
        PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
        PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
        PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
        else -> "unknown"
    }

    companion object {
        private const val NANOS_PER_MILLISECOND = 1_000_000L
    }
}
