package com.humansandmachines.gsv.wear.provisioning

import com.humansandmachines.gsv.wear.config.ConnectionFields
import com.humansandmachines.gsv.wear.config.ProvisionedCredentials
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class GsvProvisionerTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun passwordSessionEnrollsDriverAndAssistantWithoutUserSuppliedTokens() = runBlocking {
        val calls = CopyOnWriteArrayList<JSONObject>()
        server.enqueue(MockResponse().withWebSocketUpgrade(enrollmentGateway(calls)))
        val gatewayUrl = server.url("/ws").toString().replaceFirst("http://", "ws://")
        var persisted: ProvisionedCredentials? = null

        GsvProvisioner.provision(
            fields = ConnectionFields(gatewayUrl, "alice", "android-pixel-a1b2"),
            password = "one-time-password",
            deviceLabel = "Pixel 10",
            persist = { persisted = it },
        )

        assertEquals("driver-secret", persisted?.driverToken)
        assertEquals("assistant-secret", persisted?.voiceToken)
        assertEquals(listOf("sys.connect", "sys.token.create", "sys.token.create"), calls.map { it.getString("call") })
        val connectAuth = calls.first().getJSONObject("args").getJSONObject("auth")
        assertEquals("one-time-password", connectAuth.getString("password"))
        assertFalse(connectAuth.has("token"))
        val driverArgs = calls[1].getJSONObject("args")
        assertEquals("node", driverArgs.getString("kind"))
        assertEquals("android-pixel-a1b2", driverArgs.getString("allowedDeviceId"))
        val voiceArgs = calls[2].getJSONObject("args")
        assertEquals("user", voiceArgs.getString("kind"))
        assertFalse(voiceArgs.has("allowedDeviceId"))
    }

    @Test
    fun failedPersistenceRevokesBothIssuedCredentials() = runBlocking {
        val calls = CopyOnWriteArrayList<JSONObject>()
        server.enqueue(MockResponse().withWebSocketUpgrade(enrollmentGateway(calls)))
        val gatewayUrl = server.url("/ws").toString().replaceFirst("http://", "ws://")
        var failed = false

        try {
            GsvProvisioner.provision(
                fields = ConnectionFields(gatewayUrl, "alice", "android-pixel-a1b2"),
                password = "one-time-password",
                deviceLabel = "Pixel 10",
                persist = { error("storage failed") },
            )
        } catch (error: IllegalStateException) {
            failed = error.message == "storage failed"
        }

        assertTrue(failed)
        assertEquals(
            listOf("assistant-id", "driver-id"),
            calls.filter { it.getString("call") == "sys.token.revoke" }
                .map { it.getJSONObject("args").getString("tokenId") },
        )
    }

    private fun enrollmentGateway(calls: MutableList<JSONObject>): WebSocketListener =
        object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val request = JSONObject(text)
                calls += request
                val id = request.getString("id")
                when (request.getString("call")) {
                    "sys.connect" -> {
                        val peerId = request.getJSONObject("args").getJSONObject("peer").getString("id")
                        webSocket.send(success(id, connectData(peerId)).toString())
                    }
                    "sys.token.create" -> {
                        val args = request.getJSONObject("args")
                        val isDriver = args.getString("kind") == "node"
                        val token = JSONObject()
                            .put("tokenId", if (isDriver) "driver-id" else "assistant-id")
                            .put("token", if (isDriver) "driver-secret" else "assistant-secret")
                            .put("kind", if (isDriver) "node" else "user")
                            .put("allowedRole", if (isDriver) "driver" else "user")
                            .put(
                                "allowedDeviceId",
                                if (isDriver) args.getString("allowedDeviceId") else JSONObject.NULL,
                            )
                        webSocket.send(success(id, JSONObject().put("token", token)).toString())
                    }
                    "sys.token.revoke" -> {
                        webSocket.send(success(id, JSONObject().put("revoked", true)).toString())
                    }
                    else -> error("Unexpected call ${request.getString("call")}")
                }
            }
        }

    private fun connectData(peerId: String): JSONObject = JSONObject()
        .put("protocol", 3)
        .put(
            "peer",
            JSONObject()
                .put("id", peerId)
                .put(
                    "principal",
                    JSONObject()
                        .put("kind", "human")
                        .put("account", JSONObject().put("uid", 1000)),
                )
                .put(
                    "grant",
                    JSONObject()
                        .put("calls", JSONArray(listOf("sys.token.create", "sys.token.revoke")))
                        .put("signals", JSONArray()),
                ),
        )

    private fun success(id: String, data: JSONObject): JSONObject = JSONObject()
        .put("type", "res")
        .put("id", id)
        .put("ok", true)
        .put("data", data)
}
