package com.humansandmachines.gsv.wear

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
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
import com.humansandmachines.gsv.wear.runtime.RuntimeSnapshot
import com.humansandmachines.gsv.wear.runtime.WearRuntimeService
import com.humansandmachines.gsv.wear.runtime.WearRuntimeState
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var configStore: DriverConfigStore
    private var pendingArm = false

    private val permissionRequest = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val granted = requiredPermissions().all { permission ->
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

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                WearRuntimeState.snapshot.collect(::renderRuntime)
            }
        }
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
        val missing = requiredPermissions().filter { permission ->
            ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            pendingArm = false
            WearRuntimeService.arm(this)
        } else {
            permissionRequest.launch(missing.toTypedArray())
        }
    }

    private fun requiredPermissions(): List<String> = buildList {
        add(Manifest.permission.CAMERA)
        add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
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

    private fun Enum<*>.displayName(): String = name.lowercase().replaceFirstChar(Char::uppercase)
}
