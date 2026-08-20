package com.humansandmachines.gsv.wear.config

import android.content.Context

class DriverConfigStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val credentials = CredentialStore(context)

    fun loadFields(): ConnectionFields? {
        val gatewayUrl = preferences.getString(KEY_GATEWAY_URL, null) ?: return null
        val username = preferences.getString(KEY_USERNAME, null) ?: return null
        val deviceId = preferences.getString(KEY_DEVICE_ID, null) ?: return null
        return ConnectionFields(gatewayUrl, username, deviceId)
    }

    fun hasToken(): Boolean = credentials.hasToken()

    fun save(
        fields: ConnectionFields,
        replacementToken: String?,
        allowCleartext: Boolean,
    ): String? {
        val token = replacementToken ?: credentials.loadToken() ?: ""
        DriverConfig.validate(fields, token, allowCleartext)?.let { return it }
        if (replacementToken != null) {
            credentials.saveToken(replacementToken)
        }
        val saved = preferences.edit()
            .putString(KEY_GATEWAY_URL, fields.gatewayUrl)
            .putString(KEY_USERNAME, fields.username)
            .putString(KEY_DEVICE_ID, fields.deviceId)
            .commit()
        return if (saved) null else "Could not persist the connection settings"
    }

    fun load(allowCleartext: Boolean): DriverConfig? {
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

    companion object {
        private const val PREFERENCES = "gsv_wear_connection"
        private const val KEY_GATEWAY_URL = "gateway_url"
        private const val KEY_USERNAME = "username"
        private const val KEY_DEVICE_ID = "device_id"
    }
}
