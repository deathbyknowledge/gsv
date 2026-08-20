package com.humansandmachines.gsv.wear

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import com.humansandmachines.gsv.wear.config.ConnectionFields
import com.humansandmachines.gsv.wear.config.DriverConfigStore
import com.humansandmachines.gsv.wear.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var configStore: DriverConfigStore

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
    }

    private fun saveConnection() {
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
    }
}
