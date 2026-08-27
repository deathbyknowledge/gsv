package com.humansandmachines.gsv.wear.protocol

import com.humansandmachines.gsv.wear.config.DriverConfig
import org.json.JSONArray
import org.json.JSONObject

data class BodyDescriptor(val streamId: Long, val length: Long?)

data class IncomingRequest(
    val id: String,
    val call: String,
    val args: JSONObject,
    val body: BodyDescriptor?,
)

sealed interface IncomingTextFrame {
    data class Response(val id: String, val json: JSONObject) : IncomingTextFrame
    data class Request(val request: IncomingRequest) : IncomingTextFrame
    data class RequestCancel(val id: String) : IncomingTextFrame
    data class PeerPong(val nonce: String) : IncomingTextFrame
    data object Ignored : IncomingTextFrame
}

object GsvProtocol {
    const val VERSION = 3
    const val REQUEST_CANCEL_SIGNAL = "request.cancel"
    const val PEER_PING_SIGNAL = "peer.ping"
    const val PEER_PONG_SIGNAL = "peer.pong"
    val DRIVER_IMPLEMENTS: List<String> = listOf("fs.*", "shell.exec", "net.fetch")

    fun connectFrame(id: String, config: DriverConfig): String = JSONObject()
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
                        .put("id", config.deviceId)
                        .put("version", "0.1.0")
                        .put("platform", "android")
                        .put("implements", JSONArray(DRIVER_IMPLEMENTS)),
                )
                .put(
                    "auth",
                    JSONObject()
                        .put("username", config.username)
                        .put("token", config.token),
                ),
        )
        .toString()

    fun heartbeatFrame(nonce: String, nowMillis: Long): String = JSONObject()
        .put("type", "sig")
        .put("signal", PEER_PING_SIGNAL)
        .put(
            "payload",
            JSONObject()
                .put("at", nowMillis)
                .put("nonce", nonce),
        )
        .toString()

    fun parseText(text: String): IncomingTextFrame {
        val json = JSONObject(text)
        return when (json.requireString("type")) {
            "res" -> IncomingTextFrame.Response(json.requireString("id"), json)
            "req" -> IncomingTextFrame.Request(
                IncomingRequest(
                    id = json.requireString("id"),
                    call = json.requireString("call"),
                    args = json.optJSONObject("args") ?: JSONObject(),
                    body = json.optJSONObject("body")?.let(::parseBodyDescriptor),
                ),
            )
            "sig" -> {
                when (json.optString("signal")) {
                    REQUEST_CANCEL_SIGNAL -> {
                        val id = json.optJSONObject("payload")?.optString("id").orEmpty()
                        if (id.isBlank()) IncomingTextFrame.Ignored else IncomingTextFrame.RequestCancel(id)
                    }
                    PEER_PONG_SIGNAL -> {
                        val nonce = json.optJSONObject("payload")?.optString("nonce").orEmpty()
                        if (nonce.isBlank()) IncomingTextFrame.Ignored else IncomingTextFrame.PeerPong(nonce)
                    }
                    else -> IncomingTextFrame.Ignored
                }
            }
            else -> IncomingTextFrame.Ignored
        }
    }

    fun successfulResponse(id: String, data: JSONObject, body: BodyDescriptor? = null): String =
        JSONObject()
            .put("type", "res")
            .put("id", id)
            .put("ok", true)
            .put("data", data)
            .apply {
                if (body != null) {
                    put(
                        "body",
                        JSONObject().put("streamId", body.streamId).apply {
                            body.length?.let { put("length", it) }
                        },
                    )
                }
            }
            .toString()

    fun errorResponse(id: String, code: Int, message: String): String = JSONObject()
        .put("type", "res")
        .put("id", id)
        .put("ok", false)
        .put(
            "error",
            JSONObject()
                .put("code", code)
                .put("message", message),
        )
        .toString()

    fun validateConnectResponse(json: JSONObject, expectedDeviceId: String): ConnectFailure? {
        if (!json.optBoolean("ok")) {
            val code = json.optJSONObject("error")?.optInt("code", 0) ?: 0
            return when (code) {
                401, 403 -> ConnectFailure.AUTHENTICATION
                425 -> ConnectFailure.SETUP_REQUIRED
                423, 503 -> ConnectFailure.GATEWAY_UNAVAILABLE
                else -> ConnectFailure.HANDSHAKE_REJECTED
            }
        }
        val data = json.optJSONObject("data") ?: return ConnectFailure.PROTOCOL
        if (data.optInt("protocol", -1) != VERSION) return ConnectFailure.PROTOCOL
        val peer = data.optJSONObject("peer") ?: return ConnectFailure.PROTOCOL
        if (peer.optString("id") != expectedDeviceId) return ConnectFailure.PROTOCOL
        val principal = peer.optJSONObject("principal") ?: return ConnectFailure.PROTOCOL
        if (principal.optString("kind") != "machine") return ConnectFailure.PROTOCOL
        if (principal.optJSONObject("account")?.optInt("uid", -1) == -1) return ConnectFailure.PROTOCOL
        val grant = peer.optJSONObject("grant") ?: return ConnectFailure.PROTOCOL
        val implements = grant.optJSONArray("implements")?.strings() ?: return ConnectFailure.PROTOCOL
        if (implements != DRIVER_IMPLEMENTS.toSet()) return ConnectFailure.PROTOCOL
        val signals = grant.optJSONArray("signals")?.strings() ?: return ConnectFailure.PROTOCOL
        if (PEER_PONG_SIGNAL !in signals) return ConnectFailure.PROTOCOL
        return null
    }

    private fun JSONArray.strings(): Set<String> = buildSet {
        for (index in 0 until length()) {
            optString(index).takeIf(String::isNotBlank)?.let(::add)
        }
    }

    private fun parseBodyDescriptor(json: JSONObject): BodyDescriptor {
        val streamId = json.optLong("streamId", 0L)
        require(streamId in 1..BinaryFrameCodec.MAX_STREAM_ID) { "Invalid body stream id" }
        val length = if (json.has("length")) json.optLong("length", -1L) else null
        require(length == null || length >= 0) { "Invalid body length" }
        return BodyDescriptor(streamId, length)
    }

    private fun JSONObject.requireString(key: String): String =
        optString(key).takeIf(String::isNotBlank) ?: throw IllegalArgumentException("Missing $key")
}

enum class ConnectFailure {
    AUTHENTICATION,
    SETUP_REQUIRED,
    GATEWAY_UNAVAILABLE,
    HANDSHAKE_REJECTED,
    PROTOCOL,
    NETWORK,
    CLOSED,
}
