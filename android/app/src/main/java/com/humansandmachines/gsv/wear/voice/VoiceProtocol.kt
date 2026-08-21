package com.humansandmachines.gsv.wear.voice

import com.humansandmachines.gsv.wear.protocol.BinaryFrameCodec
import com.humansandmachines.gsv.wear.protocol.BodyDescriptor
import org.json.JSONObject

sealed interface VoiceCredential {
    data class Token(val value: String) : VoiceCredential

    data class Password(val value: String) : VoiceCredential
}

data class VoiceSessionConfig(
    val gatewayUrl: String,
    val username: String,
    val clientId: String,
    val credential: VoiceCredential,
)

data class VoiceConnectResult(
    val uid: Int,
    val syscalls: Set<String>,
)

data class VoiceResponse(
    val data: JSONObject,
    val body: ByteArray? = null,
)

data class SynthesizedVoice(
    val bytes: ByteArray,
    val mimeType: String,
)

sealed interface VoiceRunTerminal {
    data class Finished(val payload: JSONObject) : VoiceRunTerminal

    data object ApprovalRequired : VoiceRunTerminal
}

object VoiceProtocol {
    const val VERSION = 2

    fun connectFrame(id: String, config: VoiceSessionConfig): String = JSONObject()
        .put("type", "req")
        .put("id", id)
        .put("call", "sys.connect")
        .put(
            "args",
            JSONObject()
                .put("protocol", VERSION)
                .put(
                    "client",
                    JSONObject()
                        .put("id", config.clientId)
                        .put("version", "0.1.0")
                        .put("platform", "android")
                        .put("role", "user"),
                )
                .put(
                    "auth",
                    JSONObject()
                        .put("username", config.username)
                        .apply {
                            when (val credential = config.credential) {
                                is VoiceCredential.Token -> put("token", credential.value)
                                is VoiceCredential.Password -> put("password", credential.value)
                            }
                        },
                ),
        )
        .toString()

    fun requestFrame(
        id: String,
        call: String,
        args: JSONObject,
        body: BodyDescriptor? = null,
    ): String = JSONObject()
        .put("type", "req")
        .put("id", id)
        .put("call", call)
        .put("args", args)
        .apply {
            if (body != null) {
                put(
                    "body",
                    JSONObject()
                        .put("streamId", body.streamId)
                        .apply { body.length?.let { put("length", it) } },
                )
            }
        }
        .toString()

    fun requestCancelFrame(id: String): String = JSONObject()
        .put("type", "sig")
        .put("signal", "request.cancel")
        .put("payload", JSONObject().put("id", id).put("reason", "Voice request cancelled"))
        .toString()

    fun validateConnectResponse(json: JSONObject): VoiceConnectResult {
        if (!json.optBoolean("ok")) {
            val message = json.optJSONObject("error")?.optString("message").orEmpty()
            throw VoiceClientFailure(message.ifBlank { "Voice client authentication failed" })
        }
        val data = json.optJSONObject("data") ?: throw VoiceClientFailure("Voice client handshake was invalid")
        if (data.optInt("protocol", -1) != VERSION) {
            throw VoiceClientFailure("Voice client protocol was rejected")
        }
        val identity = data.optJSONObject("identity")
            ?: throw VoiceClientFailure("Voice client identity was missing")
        if (identity.optString("role") != "user") {
            throw VoiceClientFailure("Gateway did not establish a user connection")
        }
        val uid = identity.optJSONObject("process")?.optInt("uid", -1) ?: -1
        if (uid < 0) throw VoiceClientFailure("Voice client identity was invalid")
        val values = data.optJSONArray("syscalls") ?: throw VoiceClientFailure("Voice client capabilities were missing")
        val syscalls = buildSet {
            for (index in 0 until values.length()) {
                values.optString(index).takeIf(String::isNotBlank)?.let(::add)
            }
        }
        return VoiceConnectResult(uid, syscalls)
    }

    fun parseBodyDescriptor(json: JSONObject?): BodyDescriptor? {
        if (json == null) return null
        val streamId = json.optLong("streamId", 0L)
        if (streamId !in 1..BinaryFrameCodec.MAX_STREAM_ID) {
            throw VoiceClientFailure("Voice response body stream was invalid")
        }
        val length = if (json.has("length")) json.optLong("length", -1L) else null
        if (length != null && length < 0) throw VoiceClientFailure("Voice response body length was invalid")
        return BodyDescriptor(streamId, length)
    }

    fun allows(capabilities: Set<String>, call: String): Boolean = capabilities.any { capability ->
        capability == "*" ||
            capability == call ||
            capability.endsWith(".*") && call.startsWith(capability.dropLast(1))
    }
}

class VoiceClientFailure(message: String) : Exception(message)
