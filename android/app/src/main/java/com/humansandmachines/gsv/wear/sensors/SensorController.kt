package com.humansandmachines.gsv.wear.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread
import com.humansandmachines.gsv.wear.authority.AuthorityLease
import com.humansandmachines.gsv.wear.authority.WearAuthority
import java.io.Closeable
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.sqrt
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject

class SensorCaptureFailure(message: String) : Exception(message)

interface WearSensors {
    fun status(): JSONObject

    suspend fun sampleImu(lease: AuthorityLease, durationMillis: Long): JSONObject

    suspend fun gestureSession(lease: AuthorityLease, durationMillis: Long): JSONObject

    suspend fun orientation(lease: AuthorityLease, durationMillis: Long): JSONObject
}

class SensorController(
    context: Context,
    private val authority: WearAuthority,
) : WearSensors, Closeable {
    private val sensorManager = context.getSystemService(SensorManager::class.java)
    private val thread = HandlerThread("gsv-wear-sensors").apply { start() }
    private val handler = Handler(thread.looper)
    private val sessionMutex = Mutex()
    private val closed = AtomicBoolean(false)

    @Volatile
    private var activeListener: SensorEventListener? = null

    override fun status(): JSONObject {
        val sensors = JSONArray()
        sensorManager.getSensorList(Sensor.TYPE_ALL)
            .distinctBy { it.type }
            .sortedBy { it.type }
            .forEach { sensor ->
                sensors.put(
                    JSONObject()
                        .put("type", sensor.type)
                        .put("name", sensor.name)
                        .put("vendor", sensor.vendor)
                        .put("wakeUp", sensor.isWakeUpSensor),
                )
            }
        return JSONObject()
            .put("accelerometer", sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null)
            .put("gyroscope", sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null)
            .put("rotationVector", sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR) != null)
            .put("sensors", sensors)
    }

    override suspend fun sampleImu(lease: AuthorityLease, durationMillis: Long): JSONObject =
        collect(lease, durationMillis).toJson(includeGesture = false)

    override suspend fun gestureSession(lease: AuthorityLease, durationMillis: Long): JSONObject =
        collect(lease, durationMillis).toJson(includeGesture = true)

    override suspend fun orientation(lease: AuthorityLease, durationMillis: Long): JSONObject {
        val result = collect(lease, durationMillis)
        return result.orientationJson()
            ?: throw SensorCaptureFailure("Rotation-vector sensor is unavailable")
    }

    private suspend fun collect(lease: AuthorityLease, durationMillis: Long): SensorSummary {
        if (durationMillis !in MIN_SESSION_MILLIS..MAX_SESSION_MILLIS) {
            throw SensorCaptureFailure("Sensor duration must be between $MIN_SESSION_MILLIS and $MAX_SESSION_MILLIS ms")
        }
        if (!authority.isCurrent(lease)) throw SensorCaptureFailure("Wear Mode is not armed")
        if (closed.get()) throw SensorCaptureFailure("Sensor controller is closed")

        return sessionMutex.withLock {
            val accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
            val gyroscope = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
            val rotation = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
            if (accelerometer == null && gyroscope == null && rotation == null) {
                throw SensorCaptureFailure("No motion sensors are available")
            }

            val summary = SensorSummary(System.currentTimeMillis())
            val listener = object : SensorEventListener {
                override fun onSensorChanged(event: SensorEvent) {
                    summary.add(event)
                }

                override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
            }
            activeListener = listener
            try {
                var registered = false
                for (sensor in listOfNotNull(accelerometer, gyroscope, rotation)) {
                    registered = sensorManager.registerListener(
                        listener,
                        sensor,
                        SensorManager.SENSOR_DELAY_GAME,
                        handler,
                    ) || registered
                }
                if (!registered) throw SensorCaptureFailure("Motion sensors could not be started")
                val deadline = android.os.SystemClock.elapsedRealtime() + durationMillis
                while (true) {
                    val remaining = deadline - android.os.SystemClock.elapsedRealtime()
                    if (remaining <= 0) break
                    delay(minOf(remaining, AUTHORITY_RECHECK_MILLIS))
                    if (!authority.isCurrent(lease)) {
                        throw SensorCaptureFailure("Wear Mode authority changed during sensor session")
                    }
                }
            } finally {
                sensorManager.unregisterListener(listener)
                activeListener = null
                summary.complete(System.currentTimeMillis())
            }
            summary
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        activeListener?.let(sensorManager::unregisterListener)
        activeListener = null
        thread.quitSafely()
    }

    private class SensorSummary(private val startedAtMillis: Long) {
        private val lock = Any()
        private var completedAtMillis = startedAtMillis
        private var accelerometerSamples = 0
        private var gyroscopeSamples = 0
        private var rotationSamples = 0
        private var accelerationMagnitudeSum = 0.0
        private var maximumAcceleration = 0.0
        private var maximumLinearAcceleration = 0.0
        private var gyroscopeMagnitudeSum = 0.0
        private var maximumGyroscope = 0.0
        private var shakeCount = 0
        private var lastShakeNanos = 0L
        private var lastOrientation: FloatArray? = null

        fun add(event: SensorEvent) = synchronized(lock) {
            when (event.sensor.type) {
                Sensor.TYPE_ACCELEROMETER -> {
                    val magnitude = vectorMagnitude(event.values)
                    val linear = abs(magnitude - SensorManager.GRAVITY_EARTH)
                    accelerometerSamples += 1
                    accelerationMagnitudeSum += magnitude
                    maximumAcceleration = maxOf(maximumAcceleration, magnitude)
                    maximumLinearAcceleration = maxOf(maximumLinearAcceleration, linear)
                    if (
                        linear >= SHAKE_ACCELERATION_METERS_PER_SECOND_SQUARED &&
                        event.timestamp - lastShakeNanos >= SHAKE_DEBOUNCE_NANOS
                    ) {
                        shakeCount += 1
                        lastShakeNanos = event.timestamp
                    }
                }
                Sensor.TYPE_GYROSCOPE -> {
                    val magnitude = vectorMagnitude(event.values)
                    gyroscopeSamples += 1
                    gyroscopeMagnitudeSum += magnitude
                    maximumGyroscope = maxOf(maximumGyroscope, magnitude)
                }
                Sensor.TYPE_ROTATION_VECTOR -> {
                    val matrix = FloatArray(9)
                    val orientation = FloatArray(3)
                    SensorManager.getRotationMatrixFromVector(matrix, event.values)
                    SensorManager.getOrientation(matrix, orientation)
                    lastOrientation = orientation
                    rotationSamples += 1
                }
            }
        }

        fun complete(atMillis: Long) = synchronized(lock) {
            completedAtMillis = atMillis
        }

        fun toJson(includeGesture: Boolean): JSONObject = synchronized(lock) {
            JSONObject()
                .put("startedAt", startedAtMillis)
                .put("completedAt", completedAtMillis)
                .put("durationMs", completedAtMillis - startedAtMillis)
                .put(
                    "accelerometer",
                    JSONObject()
                        .put("samples", accelerometerSamples)
                        .put(
                            "averageMagnitudeMetersPerSecondSquared",
                            if (accelerometerSamples == 0) 0.0 else accelerationMagnitudeSum / accelerometerSamples,
                        )
                        .put("maximumMagnitudeMetersPerSecondSquared", maximumAcceleration)
                        .put("maximumLinearMetersPerSecondSquared", maximumLinearAcceleration),
                )
                .put(
                    "gyroscope",
                    JSONObject()
                        .put("samples", gyroscopeSamples)
                        .put(
                            "averageRadiansPerSecond",
                            if (gyroscopeSamples == 0) 0.0 else gyroscopeMagnitudeSum / gyroscopeSamples,
                        )
                        .put("maximumRadiansPerSecond", maximumGyroscope),
                )
                .apply { orientationJson()?.let { put("orientation", it) } }
                .apply {
                    if (includeGesture) {
                        put(
                            "gesture",
                            JSONObject()
                                .put("shakeCount", shakeCount)
                                .put("shaken", shakeCount > 0)
                                .put(
                                    "motion",
                                    when {
                                        maximumLinearAcceleration >= 12.0 -> "vigorous"
                                        maximumLinearAcceleration >= 2.0 -> "moving"
                                        else -> "still"
                                    },
                                ),
                        )
                    }
                }
        }

        fun orientationJson(): JSONObject? = synchronized(lock) {
            lastOrientation?.let { orientation ->
                JSONObject()
                    .put("samples", rotationSamples)
                    .put("azimuthDegrees", Math.toDegrees(orientation[0].toDouble()))
                    .put("pitchDegrees", Math.toDegrees(orientation[1].toDouble()))
                    .put("rollDegrees", Math.toDegrees(orientation[2].toDouble()))
            }
        }

        private fun vectorMagnitude(values: FloatArray): Double {
            val x = values.getOrElse(0) { 0f }.toDouble()
            val y = values.getOrElse(1) { 0f }.toDouble()
            val z = values.getOrElse(2) { 0f }.toDouble()
            return sqrt(x * x + y * y + z * z)
        }
    }

    companion object {
        const val MIN_SESSION_MILLIS = 250L
        const val MAX_SESSION_MILLIS = 120_000L
        private const val AUTHORITY_RECHECK_MILLIS = 250L
        private const val SHAKE_ACCELERATION_METERS_PER_SECOND_SQUARED = 18.0
        private const val SHAKE_DEBOUNCE_NANOS = 300_000_000L
    }
}
