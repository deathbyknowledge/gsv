package com.humansandmachines.gsv.wear.voice

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHeadset
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout

class HeadsetVoiceCommandSession private constructor(
    private val audioManager: AudioManager,
    private val bluetoothManager: BluetoothManager,
    private val headset: BluetoothHeadset,
    private val device: BluetoothDevice,
) : VoiceCaptureRoute {
    private val closed = AtomicBoolean(false)
    private var recognitionStarted = false

    override val preferredInputDevice: AudioDeviceInfo?
        @SuppressLint("MissingPermission")
        get() {
            val address = runCatching(device::getAddress).getOrNull()
            return audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { candidate ->
                candidate.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO &&
                    (
                        Build.VERSION.SDK_INT < Build.VERSION_CODES.P ||
                            address.isNullOrBlank() ||
                            candidate.address.equals(address, ignoreCase = true)
                    )
            }
        }

    @SuppressLint("MissingPermission")
    private fun start(): Boolean {
        recognitionStarted = runCatching { headset.startVoiceRecognition(device) }.getOrDefault(false)
        return recognitionStarted
    }

    @SuppressLint("MissingPermission")
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        if (recognitionStarted) runCatching { headset.stopVoiceRecognition(device) }
        bluetoothManager.adapter?.closeProfileProxy(BluetoothProfile.HEADSET, headset)
    }

    companion object {
        private const val PROFILE_TIMEOUT_MILLIS = 4_000L

        @SuppressLint("MissingPermission")
        suspend fun open(context: Context, intent: Intent): HeadsetVoiceCommandSession {
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                throw VoiceClientFailure("Nearby-device permission is unavailable")
            }
            val bluetoothManager = context.getSystemService(BluetoothManager::class.java)
            val adapter = bluetoothManager.adapter
                ?: throw VoiceClientFailure("Bluetooth is unavailable")
            val audioManager = context.getSystemService(AudioManager::class.java)
            val requestedDevice = intent.bluetoothDevice()

            return withTimeout(PROFILE_TIMEOUT_MILLIS) {
                suspendCancellableCoroutine { continuation ->
                    val pending = AtomicReference<HeadsetVoiceCommandSession?>()
                    continuation.invokeOnCancellation { pending.getAndSet(null)?.close() }
                    val listener = object : BluetoothProfile.ServiceListener {
                        override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
                            if (profile != BluetoothProfile.HEADSET || proxy !is BluetoothHeadset) return
                            val connected = runCatching { proxy.connectedDevices }.getOrDefault(emptyList())
                            val device = requestedDevice?.takeIf(connected::contains) ?: connected.firstOrNull()
                            if (device == null) {
                                adapter.closeProfileProxy(BluetoothProfile.HEADSET, proxy)
                                if (continuation.isActive) {
                                    continuation.resumeWithException(
                                        VoiceClientFailure("No connected Bluetooth headset is available"),
                                    )
                                }
                                return
                            }
                            val session = HeadsetVoiceCommandSession(
                                audioManager = audioManager,
                                bluetoothManager = bluetoothManager,
                                headset = proxy,
                                device = device,
                            )
                            if (!session.start()) {
                                session.close()
                                if (continuation.isActive) {
                                    continuation.resumeWithException(
                                        VoiceClientFailure("Bluetooth voice recognition could not start"),
                                    )
                                }
                                return
                            }
                            pending.set(session)
                            if (continuation.isActive) {
                                continuation.resume(session)
                                pending.compareAndSet(session, null)
                            } else {
                                pending.getAndSet(null)?.close()
                            }
                        }

                        override fun onServiceDisconnected(profile: Int) {
                            if (profile == BluetoothProfile.HEADSET && continuation.isActive) {
                                continuation.resumeWithException(
                                    VoiceClientFailure("Bluetooth headset service disconnected"),
                                )
                            }
                        }
                    }
                    if (!adapter.getProfileProxy(context, listener, BluetoothProfile.HEADSET)) {
                        continuation.resumeWithException(
                            VoiceClientFailure("Bluetooth headset service is unavailable"),
                        )
                    }
                }
            }
        }

        @Suppress("DEPRECATION")
        private fun Intent.bluetoothDevice(): BluetoothDevice? =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
            } else {
                getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
            }
    }
}
