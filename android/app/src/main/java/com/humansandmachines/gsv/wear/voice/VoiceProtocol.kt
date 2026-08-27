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
    val calls: Set<String>,
    val signals: Set<String>,
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
    data class Answer(val text: String) : VoiceRunTerminal

    data class Finished(val payload: JSONObject) : VoiceRunTerminal

    data object ApprovalRequired : VoiceRunTerminal
}

data class VoiceTerminalEvent(
    val runId: String,
    val terminal: VoiceRunTerminal,
)

object VoiceProtocol {
    const val VERSION = 3

    fun connectFrame(id: String, config: VoiceSessionConfig): String = JSONObject()
        .put("type", "req")
        .put("id", id)
        .put("call", "sys.connect")
        .put(
            "args",
            JSONObject()
                .put("protocol", VERSION)
                .put(
                    "peer",
                    JSONObject()
                        .put("id", config.clientId)
                        .put("version", "0.1.0")
                        .put("platform", "android"),
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

    fun validateConnectResponse(json: JSONObject, expectedPeerId: String): VoiceConnectResult {
        if (!json.optBoolean("ok")) {
            val message = json.optJSONObject("error")?.optString("message").orEmpty()
            throw VoiceClientFailure(message.ifBlank { "Voice client authentication failed" })
        }
        val data = json.optJSONObject("data") ?: throw VoiceClientFailure("Voice client handshake was invalid")
        if (data.optInt("protocol", -1) != VERSION) {
            throw VoiceClientFailure("Voice client protocol was rejected")
        }
        val peer = data.optJSONObject("peer")
            ?: throw VoiceClientFailure("Voice client peer was missing")
        if (peer.optString("id") != expectedPeerId) {
            throw VoiceClientFailure("Gateway established the wrong voice peer")
        }
        val principal = peer.optJSONObject("principal")
            ?: throw VoiceClientFailure("Voice client principal was missing")
        if (principal.optString("kind") != "human") {
            throw VoiceClientFailure("Gateway did not establish a human peer")
        }
        val uid = principal.optJSONObject("account")?.optInt("uid", -1) ?: -1
        if (uid < 0) throw VoiceClientFailure("Voice client identity was invalid")
        val grant = peer.optJSONObject("grant")
            ?: throw VoiceClientFailure("Voice client grants were missing")
        val calls = grant.optJSONArray("calls")?.strings()
            ?: throw VoiceClientFailure("Voice client call grants were missing")
        val signals = grant.optJSONArray("signals")?.strings()
            ?: throw VoiceClientFailure("Voice client signal grants were missing")
        return VoiceConnectResult(uid, calls, signals)
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

    fun parseTerminalSignal(
        json: JSONObject,
        shipConversationId: String,
        shipHandlerPid: String,
    ): VoiceTerminalEvent? {
        val payload = json.optJSONObject("payload") ?: return null
        return when (json.optString("signal")) {
            "message.committed" -> {
                if (!payload.optBoolean("directed")) return null
                val message = payload.optJSONObject("message") ?: return null
                if (message.optString("conversationId") != shipConversationId) return null
                if (message.optString("processId") != shipHandlerPid) return null
                val author = message.optJSONObject("author") ?: return null
                if (author.optString("kind") != "process" || author.optString("pid") != shipHandlerPid) return null
                val runId = message.optString("runId").takeIf(String::isNotBlank) ?: return null
                val text = message.opt("text") as? String ?: return null
                VoiceTerminalEvent(runId, VoiceRunTerminal.Answer(text.trim()))
            }
            "message.aborted" -> {
                if (payload.optString("conversationId") != shipConversationId) return null
                if (payload.optString("processId") != shipHandlerPid) return null
                val runId = payload.optString("runId").takeIf(String::isNotBlank) ?: return null
                VoiceTerminalEvent(
                    runId,
                    VoiceRunTerminal.Finished(
                        JSONObject()
                            .put("status", "failed")
                            .put("reason", payload.optString("reason")),
                    ),
                )
            }
            "proc.run.hil.requested" -> {
                if (payload.optString("pid") != shipHandlerPid) return null
                val runId = payload.optString("runId").takeIf(String::isNotBlank) ?: return null
                VoiceTerminalEvent(runId, VoiceRunTerminal.ApprovalRequired)
            }
            "proc.run.finished" -> {
                if (payload.optString("pid") != shipHandlerPid) return null
                val runId = payload.optString("runId").takeIf(String::isNotBlank) ?: return null
                VoiceTerminalEvent(runId, VoiceRunTerminal.Finished(payload))
            }
            else -> null
        }
    }

    fun allows(capabilities: Set<String>, call: String): Boolean = capabilities.any { capability ->
        capability == "*" ||
            capability == call ||
            capability.endsWith(".*") && call.startsWith(capability.dropLast(1))
    }

    private fun org.json.JSONArray.strings(): Set<String> = buildSet {
        for (index in 0 until length()) {
            optString(index).takeIf(String::isNotBlank)?.let(::add)
        }
    }
}

class VoiceClientFailure(message: String) : Exception(message)
