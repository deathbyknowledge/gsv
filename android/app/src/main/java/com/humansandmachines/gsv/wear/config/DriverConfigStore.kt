package com.humansandmachines.gsv.wear.config

import android.content.Context
import java.util.UUID

data class ProvisionedCredentials(
    val driverToken: String,
    val voiceToken: String,
)

class DriverConfigStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val credentials = CredentialStore(context)

    fun loadFields(): ConnectionFields? {
        val gatewayUrl = preferences.getString(KEY_GATEWAY_URL, null) ?: return null
        val username = preferences.getString(KEY_USERNAME, null) ?: return null
        val deviceId = preferences.getString(KEY_DEVICE_ID, null) ?: return null
        return ConnectionFields(gatewayUrl, username, deviceId)
    }

    fun loadOrCreateDeviceId(model: String): String {
        preferences.getString(KEY_DEVICE_ID, null)?.takeIf(::validDeviceId)?.let { return it }
        val suffix = UUID.randomUUID().toString().replace("-", "").take(8)
        val deviceId = automaticDeviceId(model, suffix)
        check(preferences.edit().putString(KEY_DEVICE_ID, deviceId).commit()) {
            "Could not persist the phone identity"
        }
        return deviceId
    }

    fun saveProvisioned(
        fields: ConnectionFields,
        issued: ProvisionedCredentials,
        allowCleartext: Boolean,
    ) {
        DriverConfig.validate(fields, issued.driverToken, allowCleartext)?.let {
            throw IllegalArgumentException(it)
        }
        require(validCredential(issued.voiceToken)) { "Voice credential is invalid" }

        check(
            preferences.edit()
                .remove(KEY_PROVISIONED)
                .putBoolean(KEY_ENROLLMENT_IN_PROGRESS, true)
                .commit(),
        ) {
            "Could not begin saving the connection"
        }
        credentials.saveTokens(issued.driverToken, issued.voiceToken)
        check(
            preferences.edit()
                .putString(KEY_GATEWAY_URL, fields.gatewayUrl)
                .putString(KEY_USERNAME, fields.username)
                .putString(KEY_DEVICE_ID, fields.deviceId)
                .putBoolean(KEY_PROVISIONED, true)
                .remove(KEY_ENROLLMENT_IN_PROGRESS)
                .commit(),
        ) { "Could not persist the connection settings" }
    }

    fun isProvisioned(allowCleartext: Boolean): Boolean = runCatching {
        if (preferences.getBoolean(KEY_ENROLLMENT_IN_PROGRESS, false)) return@runCatching false
        if (!storedConfigurationIsValid(allowCleartext)) return@runCatching false
        preferences.getBoolean(KEY_PROVISIONED, false) ||
            preferences.edit().putBoolean(KEY_PROVISIONED, true).commit()
    }.getOrDefault(false)

    fun load(allowCleartext: Boolean): DriverConfig? {
        if (!isProvisioned(allowCleartext)) return null
        val fields = loadFields() ?: return null
        val token = credentials.loadToken() ?: return null
        if (DriverConfig.validate(fields, token, allowCleartext) != null) return null
        return DriverConfig(
            gatewayUrl = fields.gatewayUrl,
            username = fields.username,
            deviceId = fields.deviceId,
            token = token,
        )
    }

    fun loadVoice(allowCleartext: Boolean): VoiceClientConfig? {
        if (!isProvisioned(allowCleartext)) return null
        val fields = loadFields() ?: return null
        val driverToken = credentials.loadToken() ?: return null
        if (DriverConfig.validate(fields, driverToken, allowCleartext) != null) return null
        val token = credentials.loadVoiceToken() ?: return null
        if (!validCredential(token)) return null
        return VoiceClientConfig(
            gatewayUrl = fields.gatewayUrl,
            username = fields.username,
            clientId = "${fields.deviceId}-voice",
            token = token,
        )
    }

    private fun storedConfigurationIsValid(allowCleartext: Boolean): Boolean {
        if (!credentials.hasTokens()) return false
        val fields = loadFields() ?: return false
        val driverToken = credentials.loadToken() ?: return false
        if (DriverConfig.validate(fields, driverToken, allowCleartext) != null) return false
        val voiceToken = credentials.loadVoiceToken() ?: return false
        return validCredential(voiceToken)
    }

    companion object {
        private const val PREFERENCES = "gsv_wear_connection"
        private const val KEY_GATEWAY_URL = "gateway_url"
        private const val KEY_USERNAME = "username"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_PROVISIONED = "provisioned"
        private const val KEY_ENROLLMENT_IN_PROGRESS = "enrollment_in_progress"
        private val VALID_DEVICE_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

        internal fun automaticDeviceId(model: String, suffix: String): String {
            val normalizedModel = model.trim().lowercase().map { character ->
                when {
                    character in 'a'..'z' || character in '0'..'9' -> character
                    else -> '-'
                }
            }.joinToString("")
                .replace(Regex("-+"), "-")
                .trim('-')
                .take(80)
                .ifBlank { "phone" }
            val normalizedSuffix = suffix.lowercase().filter { it in 'a'..'z' || it in '0'..'9' }
                .take(12)
                .ifBlank { "device" }
            return "android-$normalizedModel-$normalizedSuffix"
        }

        private fun validDeviceId(value: String): Boolean = VALID_DEVICE_ID.matches(value)

        private fun validCredential(value: String): Boolean =
            value.isNotBlank() && value.length <= 4096 && value.none(Char::isISOControl)
    }
}
