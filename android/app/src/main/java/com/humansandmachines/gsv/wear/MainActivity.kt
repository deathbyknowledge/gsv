package com.humansandmachines.gsv.wear

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.service.voice.VoiceInteractionService
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.config.ConnectionFields
import com.humansandmachines.gsv.wear.config.DriverConfigStore
import com.humansandmachines.gsv.wear.notifications.AndroidNotificationAccess
import com.humansandmachines.gsv.wear.runtime.WearRuntimeService
import com.humansandmachines.gsv.wear.runtime.WearRuntimeState
import com.humansandmachines.gsv.wear.ui.ControlUiState
import com.humansandmachines.gsv.wear.ui.GsvControlScreen
import com.humansandmachines.gsv.wear.voice.GsvVoiceInteractionService
import com.humansandmachines.gsv.wear.voice.VoiceAssistantRuntime
import com.humansandmachines.gsv.wear.voice.VoiceProvisioner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private lateinit var configStore: DriverConfigStore
    private var pendingArm = false
    private var setupNotice by mutableStateOf("")
    private var voiceNotice by mutableStateOf("")
    private var notificationStatus by mutableStateOf("Not granted")
    private var assistantSelected by mutableStateOf(false)
    private var deviceTokenStored by mutableStateOf(false)
    private var voiceTokenStored by mutableStateOf(false)
    private var voiceProvisioning by mutableStateOf(false)
    private var voiceTestRunning by mutableStateOf(false)
    private var setupError by mutableStateOf(false)
    private var voiceError by mutableStateOf(false)

    private val permissionRequest = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val granted = armPermissions().all { permission ->
            result[permission] == true || ContextCompat.checkSelfPermission(this, permission) ==
                PackageManager.PERMISSION_GRANTED
        }
        if (pendingArm && granted) {
            WearRuntimeService.arm(this)
        } else if (pendingArm) {
            setupNotice = getString(R.string.permissions_required)
            setupError = true
        }
        pendingArm = false
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        configStore = DriverConfigStore(applicationContext)
        val initialFields = configStore.loadFields()
        deviceTokenStored = configStore.hasToken()
        voiceTokenStored = configStore.hasVoiceToken()

        setContent {
            val snapshot by WearRuntimeState.snapshot.collectAsStateWithLifecycle()
            GsvControlScreen(
                initialFields = initialFields,
                snapshot = snapshot,
                uiState = ControlUiState(
                    setupNotice = setupNotice,
                    voiceNotice = voiceNotice,
                    notificationStatus = notificationStatus,
                    assistantSelected = assistantSelected,
                    deviceTokenStored = deviceTokenStored,
                    voiceTokenStored = voiceTokenStored,
                    voiceProvisioning = voiceProvisioning,
                    voiceTestRunning = voiceTestRunning,
                    setupError = setupError,
                    voiceError = voiceError,
                ),
                onSaveConnection = ::saveConnection,
                onArm = ::armWearMode,
                onPauseOrResume = {
                    val action = if (snapshot.authority == AuthorityState.PAUSED) {
                        WearRuntimeService.ACTION_RESUME
                    } else {
                        WearRuntimeService.ACTION_PAUSE
                    }
                    WearRuntimeService.command(this, action)
                },
                onDisarm = {
                    WearRuntimeService.command(this, WearRuntimeService.ACTION_DISARM)
                },
                onDisconnect = {
                    WearRuntimeService.command(this, WearRuntimeService.ACTION_DISCONNECT)
                },
                onActivationStarted = ::playActivationHaptic,
                onProvisionVoice = ::provisionVoiceClient,
                onChooseAssistant = ::openAssistantSettings,
                onTestVoice = ::testVoiceAssistant,
                onOpenBatterySettings = {
                    startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                },
                onOpenNotificationSettings = {
                    startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                },
            )
        }
    }

    override fun onResume() {
        super.onResume()
        if (!::configStore.isInitialized) return
        renderNotificationAccess()
        renderAssistantSelection()
        deviceTokenStored = configStore.hasToken()
        voiceTokenStored = configStore.hasVoiceToken()
    }

    private fun saveConnection(fields: ConnectionFields, deviceToken: String): Boolean {
        val replacementToken = deviceToken.trim().ifBlank { null }
        val error = runCatching {
            configStore.save(fields, replacementToken, BuildConfig.DEBUG)
        }.getOrElse { "Could not secure the device credential" }
        setupNotice = error ?: getString(R.string.saved)
        setupError = error != null
        if (error == null) deviceTokenStored = configStore.hasToken()
        return error == null
    }

    private fun armWearMode(fields: ConnectionFields, deviceToken: String): Boolean {
        if (!saveConnection(fields, deviceToken)) return false
        pendingArm = true
        val missing = armPermissions().filter { permission ->
            ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            pendingArm = false
            WearRuntimeService.arm(this)
        } else {
            val requested = buildList {
                addAll(missing)
                if (
                    Manifest.permission.ACCESS_COARSE_LOCATION in missing &&
                    ContextCompat.checkSelfPermission(
                        this@MainActivity,
                        Manifest.permission.ACCESS_FINE_LOCATION,
                    ) != PackageManager.PERMISSION_GRANTED
                ) {
                    add(Manifest.permission.ACCESS_FINE_LOCATION)
                }
            }
            permissionRequest.launch(requested.distinct().toTypedArray())
        }
        return true
    }

    private fun armPermissions(): List<String> = buildList {
        add(Manifest.permission.CAMERA)
        add(Manifest.permission.RECORD_AUDIO)
        add(Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun provisionVoiceClient(
        fields: ConnectionFields,
        deviceToken: String,
        password: String,
    ): Boolean {
        if (!saveConnection(fields, deviceToken)) return false
        val savedFields = configStore.loadFields() ?: return false
        voiceProvisioning = true
        voiceNotice = getString(R.string.voice_client_setting_up)
        voiceError = false
        lifecycleScope.launch {
            try {
                val token = VoiceProvisioner.provision(savedFields, password)
                configStore.saveVoiceToken(token)
                voiceTokenStored = true
                voiceNotice = getString(R.string.voice_client_saved)
                voiceError = false
                if (WearRuntimeState.snapshot.value.authority != AuthorityState.DISARMED) {
                    WearRuntimeService.command(this@MainActivity, WearRuntimeService.ACTION_RELOAD_VOICE)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                voiceNotice = getString(
                    R.string.voice_client_setup_failed,
                    error.message ?: "unknown error",
                )
                voiceError = true
            } finally {
                voiceProvisioning = false
            }
        }
        return true
    }

    private fun testVoiceAssistant() {
        voiceTestRunning = true
        VoiceAssistantRuntime.startTurn(
            scope = lifecycleScope,
            onState = WearRuntimeState::setVoiceTurn,
            onFinished = { voiceTestRunning = false },
        )
    }

    private fun openAssistantSettings() {
        val primary = Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)
        val fallback = Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)
        runCatching { startActivity(primary) }.getOrElse { startActivity(fallback) }
    }

    private fun renderNotificationAccess() {
        val status = AndroidNotificationAccess(applicationContext).status()
        notificationStatus = when {
            !status.getBoolean("granted") -> getString(R.string.notification_access_not_granted)
            !status.getBoolean("connected") -> getString(R.string.notification_access_connecting)
            else -> getString(R.string.notification_access_ready)
        }
    }

    private fun renderAssistantSelection() {
        assistantSelected = VoiceInteractionService.isActiveService(
            this,
            ComponentName(this, GsvVoiceInteractionService::class.java),
        )
    }

    private fun playActivationHaptic() {
        val effect = VibrationEffect.createWaveform(
            longArrayOf(0, 38, 48, 50, 58, 68, 72, 94, 100, 145),
            intArrayOf(0, 55, 0, 82, 0, 116, 0, 164, 0, 230),
            -1,
        )
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            getSystemService(VibratorManager::class.java).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        vibrator.vibrate(effect)
    }
}
