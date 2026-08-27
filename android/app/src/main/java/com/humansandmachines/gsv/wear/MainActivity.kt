package com.humansandmachines.gsv.wear

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
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
import com.humansandmachines.gsv.wear.config.DriverConfig
import com.humansandmachines.gsv.wear.config.DriverConfigStore
import com.humansandmachines.gsv.wear.config.OnboardingInput
import com.humansandmachines.gsv.wear.notifications.AndroidNotificationAccess
import com.humansandmachines.gsv.wear.provisioning.GsvProvisioner
import com.humansandmachines.gsv.wear.runtime.WearRuntimeService
import com.humansandmachines.gsv.wear.runtime.WearRuntimeState
import com.humansandmachines.gsv.wear.ui.ControlUiState
import com.humansandmachines.gsv.wear.ui.GsvControlScreen
import com.humansandmachines.gsv.wear.ui.GsvLoginScreen
import com.humansandmachines.gsv.wear.ui.OnboardingUiState
import com.humansandmachines.gsv.wear.voice.AndroidAssistantRole
import com.humansandmachines.gsv.wear.voice.AssistantRuntimeState
import com.humansandmachines.gsv.wear.voice.VoiceAssistantRuntime
import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private lateinit var configStore: DriverConfigStore
    private lateinit var deviceId: String
    private lateinit var deviceLabel: String
    private var pendingArm = false
    private var setupComplete by mutableStateOf(false)
    private var onboardingBusy by mutableStateOf(false)
    private var onboardingNotice by mutableStateOf("")
    private var onboardingError by mutableStateOf(false)
    private var runtimeNotice by mutableStateOf("")
    private var notificationStatus by mutableStateOf("Not granted")
    private var assistantSelected by mutableStateOf(false)
    private var runtimeError by mutableStateOf(false)

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
            runtimeNotice = getString(R.string.permissions_required)
            runtimeError = true
        }
        pendingArm = false
    }

    private val assistantRoleRequest = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        renderAssistantSelection()
    }

    private val mindPermissionRequest = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            startMindTurn()
        } else {
            runtimeNotice = getString(R.string.mind_microphone_required)
            runtimeError = true
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        configStore = DriverConfigStore(applicationContext)
        val initialFields = configStore.loadFields()
        deviceId = initialFields?.deviceId ?: configStore.loadOrCreateDeviceId(Build.MODEL)
        deviceLabel = buildDeviceLabel()
        setupComplete = configStore.isProvisioned(BuildConfig.DEBUG)

        setContent {
            if (!setupComplete) {
                GsvLoginScreen(
                    initialFields = initialFields,
                    uiState = OnboardingUiState(
                        connecting = onboardingBusy,
                        notice = onboardingNotice,
                        error = onboardingError,
                    ),
                    allowCleartext = BuildConfig.DEBUG,
                    onLogin = ::loginAndEnroll,
                )
            } else {
                val wearSnapshot by WearRuntimeState.snapshot.collectAsStateWithLifecycle()
                val assistantSnapshot by AssistantRuntimeState.snapshot.collectAsStateWithLifecycle()
                GsvControlScreen(
                    wearSnapshot = wearSnapshot,
                    assistantSnapshot = assistantSnapshot,
                    uiState = ControlUiState(
                        runtimeNotice = runtimeNotice,
                        notificationStatus = notificationStatus,
                        assistantSelected = assistantSelected,
                        runtimeError = runtimeError,
                    ),
                    onMindToggle = ::toggleMindTurn,
                    onArm = ::armWearMode,
                    onPauseOrResume = {
                        val action = if (wearSnapshot.authority == AuthorityState.PAUSED) {
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
                    onChooseAssistant = ::requestAssistantRole,
                    onOpenBatterySettings = {
                        startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                    },
                    onOpenNotificationSettings = {
                        startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                    },
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (!::configStore.isInitialized) return
        renderNotificationAccess()
        renderAssistantSelection()
        if (setupComplete) (application as GsvWearApplication).assistantRuntime.reload()
        if (setupComplete && !configStore.isProvisioned(BuildConfig.DEBUG)) {
            setupComplete = false
            onboardingNotice = getString(R.string.sign_in_again)
            onboardingError = true
        }
    }

    private fun loginAndEnroll(gatewayUrl: String, username: String, password: String) {
        if (onboardingBusy) return
        val fields = ConnectionFields(gatewayUrl, username, deviceId)
        val inputError = OnboardingInput.usernameError(username)
            ?: OnboardingInput.passwordError(password)
            ?: DriverConfig.validateFields(fields, BuildConfig.DEBUG)
        if (inputError != null) {
            onboardingNotice = inputError
            onboardingError = true
            return
        }

        onboardingBusy = true
        onboardingNotice = getString(R.string.phone_enrolling)
        onboardingError = false
        lifecycleScope.launch {
            try {
                GsvProvisioner.provision(fields, password, deviceLabel) { issued ->
                    configStore.saveProvisioned(fields, issued, BuildConfig.DEBUG)
                }
                check(configStore.isProvisioned(BuildConfig.DEBUG)) {
                    "Android could not verify the saved connection"
                }
                (application as GsvWearApplication).assistantRuntime.reload()
                setupComplete = true
                onboardingNotice = ""
                onboardingError = false
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                onboardingNotice = getString(
                    R.string.phone_enrollment_failed,
                    error.message ?: "unknown error",
                )
                onboardingError = true
            } finally {
                onboardingBusy = false
            }
        }
    }

    private fun armWearMode() {
        if (!configStore.isProvisioned(BuildConfig.DEBUG)) {
            setupComplete = false
            onboardingNotice = getString(R.string.sign_in_again)
            onboardingError = true
            return
        }
        runtimeNotice = ""
        runtimeError = false
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

    private fun toggleMindTurn() {
        if (AssistantRuntimeState.snapshot.value.turn != VoiceTurnState.IDLE) {
            VoiceAssistantRuntime.cancelActiveTurn()
            return
        }
        runtimeNotice = ""
        runtimeError = false
        if (
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            startMindTurn()
        } else {
            mindPermissionRequest.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun startMindTurn() {
        if (!configStore.isProvisioned(BuildConfig.DEBUG)) {
            setupComplete = false
            onboardingNotice = getString(R.string.sign_in_again)
            onboardingError = true
            return
        }
        (application as GsvWearApplication).assistantRuntime.reload()
        VoiceAssistantRuntime.startTurn(scope = lifecycleScope)
    }

    private fun requestAssistantRole() {
        val intent = AndroidAssistantRole.requestIntent(this)
        runCatching { assistantRoleRequest.launch(intent) }.getOrElse {
            startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
        }
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
        assistantSelected = AndroidAssistantRole.isSelected(this)
    }

    private fun buildDeviceLabel(): String {
        val parts = listOf(Build.MANUFACTURER, Build.MODEL)
            .map { value -> value.trim().filterNot(Char::isISOControl) }
            .filter(String::isNotBlank)
            .distinctBy { value -> value.lowercase() }
        return parts.joinToString(" ").take(64).ifBlank { "Android phone" }
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
