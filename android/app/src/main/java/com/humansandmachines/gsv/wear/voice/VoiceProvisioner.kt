package com.humansandmachines.gsv.wear.voice

import com.humansandmachines.gsv.wear.config.ConnectionFields
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.coroutineScope
import okhttp3.OkHttpClient
import org.json.JSONObject

object VoiceProvisioner {
    suspend fun provision(fields: ConnectionFields, password: String): String = coroutineScope {
        if (password.isBlank() || password.length > 4096 || password.any(Char::isISOControl)) {
            throw VoiceClientFailure("GSV password is invalid")
        }
        val client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .build()
        val session = VoiceClientSession(
            epoch = 1L,
            config = VoiceSessionConfig(
                gatewayUrl = fields.gatewayUrl,
                username = fields.username,
                clientId = "${fields.deviceId}-voice-setup",
                credential = VoiceCredential.Password(password),
            ),
            client = client,
            scope = this,
            discoverPersonalProcess = false,
            onReady = {},
            onTerminated = { _, _ -> },
        )
        try {
            session.open()
            val connected = session.awaitReady()
            if (!VoiceProtocol.allows(connected.calls, "sys.token.create")) {
                throw VoiceClientFailure("This account cannot create a voice client token")
            }
            val response = session.request(
                call = "sys.token.create",
                args = JSONObject()
                    .put("kind", "user")
                    .put("label", "GSV Wear voice client"),
            )
            response.data.optJSONObject("token")?.optString("token")
                ?.takeIf(String::isNotBlank)
                ?: throw VoiceClientFailure("Gateway did not return a voice client token")
        } finally {
            session.close()
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
        }
    }
}
