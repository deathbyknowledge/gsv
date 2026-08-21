package com.humansandmachines.gsv.wear.protocol

import com.humansandmachines.gsv.wear.config.DriverConfig
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GsvProtocolTest {
    @Test
    fun connectFrameRegistersTheAndroidFilesystemShellAndNetwork() {
        val frame = JSONObject(
            GsvProtocol.connectFrame(
                "connect-1",
                DriverConfig("wss://example.gsv.dev/ws", "alice", "pixel-10", "token"),
            ),
        )

        val args = frame.getJSONObject("args")
        assertEquals(2, args.getInt("protocol"))
        assertEquals("driver", args.getJSONObject("client").getString("role"))
        assertEquals(
            listOf("fs.*", "shell.exec", "net.fetch"),
            args.getJSONObject("driver").getJSONArray("implements").let { array ->
                List(array.length()) { array.getString(it) }
            },
        )
    }

    @Test
    fun validatesTheAuthenticatedDriverIdentity() {
        val response = JSONObject(
            """
            {
              "type":"res",
              "id":"connect-1",
              "ok":true,
              "data":{
                "protocol":2,
                "identity":{"role":"driver","device":"pixel-10"}
              }
            }
            """.trimIndent(),
        )

        assertNull(GsvProtocol.validateConnectResponse(response, "pixel-10"))
        assertEquals(ConnectFailure.PROTOCOL, GsvProtocol.validateConnectResponse(response, "other"))
    }

    @Test
    fun parsesRequestCancellation() {
        val parsed = GsvProtocol.parseText(
            """{"type":"sig","signal":"request.cancel","payload":{"id":"req-1"}}""",
        )

        assertTrue(parsed is IncomingTextFrame.RequestCancel)
        assertEquals("req-1", (parsed as IncomingTextFrame.RequestCancel).id)
    }

    @Test
    fun ignoresDeviceStatusWhileTheConnectResponseIsPending() {
        val parsed = GsvProtocol.parseText(
            """{"type":"sig","signal":"device.status","payload":{"deviceId":"pixel-10"}}""",
        )

        assertTrue(parsed is IncomingTextFrame.Ignored)
    }

    @Test
    fun roundTripsTheDriverHeartbeatNonce() {
        val ping = JSONObject(GsvProtocol.heartbeatFrame("heartbeat-1", 1234))
        assertEquals("sig", ping.getString("type"))
        assertEquals("device.ping", ping.getString("signal"))
        assertEquals("heartbeat-1", ping.getJSONObject("payload").getString("nonce"))
        assertEquals(1234, ping.getJSONObject("payload").getLong("at"))

        val parsed = GsvProtocol.parseText(
            """{"type":"sig","signal":"device.pong","payload":{"nonce":"heartbeat-1"}}""",
        )
        assertTrue(parsed is IncomingTextFrame.DriverPong)
        assertEquals("heartbeat-1", (parsed as IncomingTextFrame.DriverPong).nonce)
    }
}
