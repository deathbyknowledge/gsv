package com.humansandmachines.gsv.wear.config

import java.net.URI

data class ConnectionFields(
    val gatewayUrl: String,
    val username: String,
    val deviceId: String,
)

class DriverConfig(
    val gatewayUrl: String,
    val username: String,
    val deviceId: String,
    val token: String,
) {
    override fun toString(): String =
        "DriverConfig(gatewayUrl=<redacted>, username=$username, deviceId=$deviceId, token=<redacted>)"

    companion object {
        private val DEVICE_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

        fun validate(
            fields: ConnectionFields,
            token: String,
            allowCleartext: Boolean,
        ): String? {
            val uri = try {
                URI(fields.gatewayUrl)
            } catch (_: Exception) {
                return "Gateway URL is invalid"
            }
            val acceptedScheme = uri.scheme == "wss" || allowCleartext && uri.scheme == "ws"
            if (!acceptedScheme || uri.host.isNullOrBlank()) {
                return if (allowCleartext) {
                    "Gateway URL must use wss:// or ws://"
                } else {
                    "Gateway URL must use wss://"
                }
            }
            if (uri.userInfo != null || uri.query != null || uri.fragment != null) {
                return "Gateway URL cannot contain credentials, a query, or a fragment"
            }
            if (uri.path != "/ws") {
                return "Gateway URL must end in /ws"
            }
            if (fields.username.isBlank() || fields.username.length > 64 || fields.username.hasControlCharacter()) {
                return "Username is invalid"
            }
            if (!DEVICE_ID.matches(fields.deviceId)) {
                return "Device ID may contain letters, numbers, dots, dashes, and underscores"
            }
            if (token.isBlank() || token.length > 4096 || token.hasControlCharacter()) {
                return "Device token is invalid"
            }
            return null
        }

        private fun String.hasControlCharacter(): Boolean = any(Char::isISOControl)
    }
}
