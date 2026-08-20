package com.humansandmachines.gsv.wear.protocol

import com.humansandmachines.gsv.wear.config.DriverConfig
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GsvProtocolTest {
    @Test
    fun connectFrameRegistersOnlyRead() {
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
            listOf("fs.read"),
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
}
