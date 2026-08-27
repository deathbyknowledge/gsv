package com.humansandmachines.gsv.wear.provisioning

import com.humansandmachines.gsv.wear.voice.VoiceClientFailure
import com.humansandmachines.gsv.wear.voice.VoiceResponse
import org.json.JSONObject

internal data class IssuedCredential(
    val tokenId: String,
    val token: String?,
    val kind: String?,
    val allowedRole: String?,
    val allowedDeviceId: String?,
    val bindingShapeValid: Boolean,
)

internal object ProvisioningProtocol {
    fun driverTokenArgs(deviceId: String, label: String): JSONObject = JSONObject()
        .put("kind", "node")
        .put("label", label)
        .put("allowedRole", "driver")
        .put("allowedDeviceId", deviceId)

    fun voiceTokenArgs(label: String): JSONObject = JSONObject()
        .put("kind", "user")
        .put("label", label)

    fun parseIssued(response: VoiceResponse): IssuedCredential {
        val json = response.data.optJSONObject("token")
            ?: throw VoiceClientFailure("Gateway did not return a credential")
        val binding = when (val value = json.opt("allowedDeviceId")) {
            null, JSONObject.NULL -> null to true
            is String -> value.takeIf(String::isNotBlank) to value.isNotBlank()
            else -> null to false
        }
        return IssuedCredential(
            tokenId = json.requiredString("tokenId", "Gateway credential id was missing"),
            token = json.optionalString("token"),
            kind = json.optionalString("kind"),
            allowedRole = json.optionalString("allowedRole"),
            allowedDeviceId = binding.first,
            bindingShapeValid = binding.second,
        )
    }

    fun requireDriver(issued: IssuedCredential, deviceId: String): String {
        if (
            issued.kind != "node" ||
            issued.allowedRole != "driver" ||
            issued.allowedDeviceId != deviceId ||
            !issued.bindingShapeValid ||
            !validCredential(issued.token)
        ) {
            throw VoiceClientFailure("Gateway returned a credential for a different phone")
        }
        return requireNotNull(issued.token)
    }

    fun requireVoice(issued: IssuedCredential): String {
        if (
            issued.kind != "user" ||
            issued.allowedRole != "user" ||
            issued.allowedDeviceId != null ||
            !issued.bindingShapeValid ||
            !validCredential(issued.token)
        ) {
            throw VoiceClientFailure("Gateway returned an invalid assistant credential")
        }
        return requireNotNull(issued.token)
    }

    private fun JSONObject.requiredString(key: String, message: String): String =
        optionalString(key) ?: throw VoiceClientFailure(message)

    private fun JSONObject.optionalString(key: String): String? =
        (opt(key) as? String)?.takeIf(String::isNotBlank)

    private fun validCredential(value: String?): Boolean =
        value != null && value.length <= 4096 && value.none(Char::isISOControl)
}
