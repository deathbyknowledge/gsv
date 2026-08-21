package com.humansandmachines.gsv.wear.voice

import com.humansandmachines.gsv.wear.protocol.BodyDescriptor
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceProtocolTest {
    @Test
    fun passwordHandshakeCreatesAUserConnectionWithoutADeviceCredential() {
        val frame = JSONObject(
            VoiceProtocol.connectFrame(
                "connect-1",
                VoiceSessionConfig(
                    gatewayUrl = "wss://example.gsv.dev/ws",
                    username = "alice",
                    clientId = "pixel-voice-setup",
                    credential = VoiceCredential.Password("secret"),
                ),
            ),
        )

        val args = frame.getJSONObject("args")
        assertEquals("user", args.getJSONObject("client").getString("role"))
        assertEquals("secret", args.getJSONObject("auth").getString("password"))
        assertFalse(args.getJSONObject("auth").has("token"))
        assertFalse(args.has("driver"))
    }

    @Test
    fun tokenHandshakeDoesNotIncludeThePasswordField() {
        val frame = JSONObject(
            VoiceProtocol.connectFrame(
                "connect-1",
                VoiceSessionConfig(
                    gatewayUrl = "wss://example.gsv.dev/ws",
                    username = "alice",
                    clientId = "pixel-voice",
                    credential = VoiceCredential.Token("user-token"),
                ),
            ),
        )

        val auth = frame.getJSONObject("args").getJSONObject("auth")
        assertEquals("user-token", auth.getString("token"))
        assertFalse(auth.has("password"))
    }

    @Test
    fun validatesUserHandshakeAndAdvertisedSyscalls() {
        val result = VoiceProtocol.validateConnectResponse(
            JSONObject(
                """
                {
                  "ok":true,
                  "data":{
                    "protocol":2,
                    "identity":{"role":"user","process":{"uid":1000}},
                    "syscalls":["proc.list","proc.send","ai.transcription.create"]
                  }
                }
                """.trimIndent(),
            ),
        )

        assertEquals(1000, result.uid)
        assertTrue("proc.send" in result.syscalls)
    }

    @Test
    fun requestFrameDescribesBinaryAudioWithoutEmbeddingItInJson() {
        val frame = JSONObject(
            VoiceProtocol.requestFrame(
                id = "voice-1",
                call = "ai.transcription.create",
                args = JSONObject().put("audio", JSONObject().put("mimeType", "audio/wav")),
                body = BodyDescriptor(streamId = 7, length = 128),
            ),
        )

        assertEquals(7, frame.getJSONObject("body").getLong("streamId"))
        assertEquals(128, frame.getJSONObject("body").getLong("length"))
        assertNull(frame.opt("audio"))
    }

    @Test
    fun rejectsInvalidResponseBodyStreams() {
        assertThrows(VoiceClientFailure::class.java) {
            VoiceProtocol.parseBodyDescriptor(JSONObject().put("streamId", 0))
        }
    }

    @Test
    fun wildcardCapabilitiesAuthorizeTheirSyscallDomain() {
        assertTrue(VoiceProtocol.allows(setOf("proc.*"), "proc.list"))
        assertTrue(VoiceProtocol.allows(setOf("proc.*"), "proc.send"))
        assertTrue(VoiceProtocol.allows(setOf("adapter.pair.*"), "adapter.pair.confirm"))
        assertFalse(VoiceProtocol.allows(setOf("proc.*"), "ai.speech.create"))
    }
}
