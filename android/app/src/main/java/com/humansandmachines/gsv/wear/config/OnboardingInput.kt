package com.humansandmachines.gsv.wear.config

import java.net.URI

object OnboardingInput {
    fun addressError(value: String): String? {
        val trimmed = value.trim()
        if (trimmed.isEmpty()) return "Type your GSV address"
        if (trimmed.contains("://")) return "Enter only the address, without wss://"
        if (trimmed.contains('/')) return "Enter only the address, without /ws"
        if (trimmed.any(Char::isISOControl)) return "GSV address is invalid"
        val parsed = parseAddress(trimmed) ?: return "Use an address like mine.gsv.space"
        if (parsed.userInfo != null) return "Keep credentials out of the address"
        if (parsed.query != null || parsed.fragment != null) {
            return "That address cannot contain a query or fragment"
        }
        if (parsed.host.isNullOrBlank()) return "That address needs a host"
        if (parsed.port !in -1..65535) return "That address has an invalid port"
        return null
    }

    fun gatewayUrl(address: String, allowCleartext: Boolean): String {
        require(addressError(address) == null) { "GSV address is invalid" }
        val parsed = requireNotNull(parseAddress(address.trim()))
        val host = requireNotNull(parsed.host)
        val renderedHost = if (host.contains(':')) "[$host]" else host.lowercase()
        val authority = if (parsed.port == -1) renderedHost else "$renderedHost:${parsed.port}"
        val scheme = if (allowCleartext && isLoopback(host)) "ws" else "wss"
        return "$scheme://$authority/ws"
    }

    fun addressFromGatewayUrl(gatewayUrl: String): String? {
        val parsed = runCatching { URI(gatewayUrl) }.getOrNull() ?: return null
        val host = parsed.host ?: return null
        if (
            parsed.scheme !in setOf("ws", "wss") ||
            parsed.path != "/ws" ||
            parsed.userInfo != null ||
            parsed.query != null ||
            parsed.fragment != null
        ) return null
        val renderedHost = if (host.contains(':')) "[$host]" else host
        return if (parsed.port == -1) renderedHost else "$renderedHost:${parsed.port}"
    }

    fun usernameError(value: String): String? {
        val trimmed = value.trim()
        return when {
            trimmed.isEmpty() -> "Type the username you use with this GSV"
            trimmed.length > 64 || trimmed.any(Char::isISOControl) -> "Username is invalid"
            else -> null
        }
    }

    fun passwordError(value: String): String? = when {
        value.isBlank() -> "Type your GSV password"
        value.length > 4096 || value.any(Char::isISOControl) -> "GSV password is invalid"
        else -> null
    }

    private fun parseAddress(value: String): URI? = runCatching { URI("https://$value") }.getOrNull()

    private fun isLoopback(host: String): Boolean {
        val normalized = host.removePrefix("[").removeSuffix("]").lowercase()
        if (normalized == "localhost" || normalized.endsWith(".localhost")) return true
        if (normalized == "::1" || normalized == "0:0:0:0:0:0:0:1") return true
        val parts = normalized.split('.')
        return parts.size == 4 && parts.first() == "127" && parts.all { part ->
            part.toIntOrNull()?.let { it in 0..255 } == true
        }
    }
}
