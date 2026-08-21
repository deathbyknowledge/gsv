package com.humansandmachines.gsv.wear

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.service.voice.VoiceInteractionService
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.config.ConnectionFields
import com.humansandmachines.gsv.wear.config.DriverConfigStore
import com.humansandmachines.gsv.wear.connection.ConnectionState
import com.humansandmachines.gsv.wear.databinding.ActivityMainBinding
import com.humansandmachines.gsv.wear.notifications.AndroidNotificationAccess
import com.humansandmachines.gsv.wear.runtime.RuntimeSnapshot
import com.humansandmachines.gsv.wear.runtime.WearRuntimeService
import com.humansandmachines.gsv.wear.runtime.WearRuntimeState
import com.humansandmachines.gsv.wear.voice.GsvVoiceInteractionService
import com.humansandmachines.gsv.wear.voice.VoiceAssistantRuntime
import com.humansandmachines.gsv.wear.voice.VoiceProvisioner
import com.humansandmachines.gsv.wear.voice.displayText
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var configStore: DriverConfigStore
    private var pendingArm = false

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
            binding.setupStatus.text = getString(R.string.permissions_required)
        }
        pendingArm = false
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        configStore = DriverConfigStore(applicationContext)

        configStore.loadFields()?.let { fields ->
            binding.gatewayUrl.setText(fields.gatewayUrl)
            binding.username.setText(fields.username)
            binding.deviceId.setText(fields.deviceId)
        }
        if (configStore.hasToken()) {
            binding.deviceToken.hint = "Device token stored securely; leave blank to keep"
        }
        binding.saveConnection.setOnClickListener { saveConnection() }
        binding.armWear.setOnClickListener { armWearMode() }
        binding.pauseWear.setOnClickListener {
            val action = if (WearRuntimeState.snapshot.value.authority == AuthorityState.PAUSED) {
                WearRuntimeService.ACTION_RESUME
            } else {
                WearRuntimeService.ACTION_PAUSE
            }
            WearRuntimeService.command(this, action)
        }
        binding.disarmWear.setOnClickListener {
            WearRuntimeService.command(this, WearRuntimeService.ACTION_DISARM)
        }
        binding.disconnectRuntime.setOnClickListener {
            WearRuntimeService.command(this, WearRuntimeService.ACTION_DISCONNECT)
        }
        binding.batterySettings.setOnClickListener {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
        binding.notificationAccessSettings.setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        binding.provisionVoiceClient.setOnClickListener { provisionVoiceClient() }
        binding.assistantSettings.setOnClickListener { openAssistantSettings() }
        binding.testVoiceAssistant.setOnClickListener {
            binding.testVoiceAssistant.isEnabled = false
            VoiceAssistantRuntime.startTurn(
                scope = lifecycleScope,
                onState = { state -> binding.voiceTurnState.text = state.displayText(this) },
                onFinished = {
                    binding.testVoiceAssistant.isEnabled = true
                    renderRuntime(WearRuntimeState.snapshot.value)
                },
            )
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                WearRuntimeState.snapshot.collect(::renderRuntime)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        renderNotificationAccess()
        renderAssistantSelection()
    }

    private fun saveConnection(): Boolean {
        val fields = ConnectionFields(
            gatewayUrl = binding.gatewayUrl.text.toString().trim(),
            username = binding.username.text.toString().trim(),
            deviceId = binding.deviceId.text.toString().trim(),
        )
        val replacementToken = binding.deviceToken.text.toString().trim().ifBlank { null }
        val error = runCatching {
            configStore.save(fields, replacementToken, BuildConfig.DEBUG)
        }.getOrElse { "Could not secure the device credential" }
        binding.setupStatus.text = error ?: getString(R.string.saved)
        if (error == null) {
            binding.deviceToken.text?.clear()
            binding.deviceToken.hint = "Device token stored securely; leave blank to keep"
        }
        return error == null
    }

    private fun armWearMode() {
        if (!saveConnection()) return
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

    private fun provisionVoiceClient() {
        if (!saveConnection()) return
        val fields = configStore.loadFields() ?: return
        val password = binding.voicePassword.text.toString()
        binding.voicePassword.text?.clear()
        binding.provisionVoiceClient.isEnabled = false
        binding.voiceClientState.text = getString(R.string.voice_client_setting_up)
        lifecycleScope.launch {
            val result = runCatching { VoiceProvisioner.provision(fields, password) }
            result.onSuccess { token ->
                configStore.saveVoiceToken(token)
                binding.voiceClientState.text = getString(R.string.voice_client_saved)
                if (WearRuntimeState.snapshot.value.authority != AuthorityState.DISARMED) {
                    WearRuntimeService.command(this@MainActivity, WearRuntimeService.ACTION_RELOAD_VOICE)
                }
            }.onFailure { error ->
                binding.voiceClientState.text = getString(
                    R.string.voice_client_setup_failed,
                    error.message ?: "unknown error",
                )
            }
            binding.provisionVoiceClient.isEnabled = true
        }
    }

    private fun openAssistantSettings() {
        val primary = Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)
        val fallback = Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)
        runCatching { startActivity(primary) }.getOrElse { startActivity(fallback) }
    }

    private fun renderRuntime(snapshot: RuntimeSnapshot) {
        val connection = buildString {
            append(snapshot.connection.displayName())
            snapshot.connectionFailure?.let { failure ->
                append(" (")
                append(failure.displayName())
                append(")")
            }
        }
        binding.connectionState.text =
            getString(R.string.runtime_state, getString(R.string.connection_label), connection)
        binding.authorityState.text =
            getString(R.string.runtime_state, getString(R.string.authority_label), snapshot.authority.displayName())
        binding.cameraState.text =
            getString(R.string.runtime_state, getString(R.string.camera_label), snapshot.camera.displayName())
        binding.microphoneState.text =
            getString(
                R.string.runtime_state,
                getString(R.string.microphone_label),
                snapshot.microphone.displayName(),
            )
        binding.voiceClientState.text = getString(
            R.string.runtime_state,
            getString(R.string.voice_connection_label),
            if (configStore.hasVoiceToken()) snapshot.voiceConnection.displayName() else {
                getString(R.string.voice_client_not_set_up)
            },
        )
        binding.voiceTurnState.text = getString(
            R.string.runtime_state,
            getString(R.string.voice_turn_label),
            snapshot.voiceTurn.displayText(this),
        )

        binding.armWear.isEnabled = snapshot.authority == AuthorityState.DISARMED
        binding.pauseWear.visibility = if (snapshot.authority == AuthorityState.DISARMED) {
            View.GONE
        } else {
            View.VISIBLE
        }
        binding.pauseWear.setText(
            if (snapshot.authority == AuthorityState.PAUSED) R.string.resume_wear else R.string.pause_wear,
        )
        binding.disarmWear.isEnabled = snapshot.authority != AuthorityState.DISARMED
        binding.disconnectRuntime.isEnabled = snapshot.connection != ConnectionState.DISCONNECTED
    }

    private fun renderNotificationAccess() {
        val status = AndroidNotificationAccess(applicationContext).status()
        val state = when {
            !status.getBoolean("granted") -> getString(R.string.notification_access_not_granted)
            !status.getBoolean("connected") -> getString(R.string.notification_access_connecting)
            else -> getString(R.string.notification_access_ready)
        }
        binding.notificationAccessState.text = getString(
            R.string.runtime_state,
            getString(R.string.notification_access_label),
            state,
        )
    }

    private fun renderAssistantSelection() {
        val selected = VoiceInteractionService.isActiveService(
            this,
            ComponentName(this, GsvVoiceInteractionService::class.java),
        )
        binding.assistantState.text = getString(
            if (selected) R.string.assistant_selected else R.string.assistant_not_selected,
        )
    }

    private fun Enum<*>.displayName(): String = name.lowercase().replaceFirstChar(Char::uppercase)
}
