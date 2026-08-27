package com.humansandmachines.gsv.wear.provisioning

import com.humansandmachines.gsv.wear.config.ConnectionFields
import com.humansandmachines.gsv.wear.config.ProvisionedCredentials
import com.humansandmachines.gsv.wear.voice.VoiceClientFailure
import com.humansandmachines.gsv.wear.voice.VoiceClientSession
import com.humansandmachines.gsv.wear.voice.VoiceCredential
import com.humansandmachines.gsv.wear.voice.VoiceProtocol
import com.humansandmachines.gsv.wear.voice.VoiceSessionConfig
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import org.json.JSONObject

object GsvProvisioner {
    suspend fun provision(
        fields: ConnectionFields,
        password: String,
        deviceLabel: String,
        persist: (ProvisionedCredentials) -> Unit,
    ) = coroutineScope {
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
                clientId = "${fields.deviceId}-setup",
                credential = VoiceCredential.Password(password),
            ),
            client = client,
            scope = this,
            discoverPersonalProcess = false,
            onReady = {},
            onTerminated = { _, _ -> },
        )
        val issued = mutableListOf<IssuedCredential>()
        var committed = false
        try {
            session.open()
            val connected = session.awaitReady()
            if (!VoiceProtocol.allows(connected.calls, "sys.token.create")) {
                throw VoiceClientFailure("This account cannot enroll an Android phone")
            }

            val driver = ProvisioningProtocol.parseIssued(
                session.request(
                    call = "sys.token.create",
                    args = ProvisioningProtocol.driverTokenArgs(fields.deviceId, deviceLabel),
                ),
            ).also(issued::add)
            val driverToken = ProvisioningProtocol.requireDriver(driver, fields.deviceId)

            val voice = ProvisioningProtocol.parseIssued(
                session.request(
                    call = "sys.token.create",
                    args = ProvisioningProtocol.voiceTokenArgs("$deviceLabel assistant"),
                ),
            ).also(issued::add)
            val voiceToken = ProvisioningProtocol.requireVoice(voice)

            persist(
                ProvisionedCredentials(
                    driverToken = driverToken,
                    voiceToken = voiceToken,
                ),
            )
            committed = true
        } finally {
            if (!committed && issued.isNotEmpty()) {
                withContext(NonCancellable) {
                    issued.asReversed().forEach { credential ->
                        runCatching {
                            session.request(
                                call = "sys.token.revoke",
                                args = JSONObject()
                                    .put("tokenId", credential.tokenId)
                                    .put("reason", "Android enrollment did not complete"),
                                timeoutMillis = 3_000,
                            )
                        }
                    }
                }
            }
            session.close()
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
        }
    }
}
