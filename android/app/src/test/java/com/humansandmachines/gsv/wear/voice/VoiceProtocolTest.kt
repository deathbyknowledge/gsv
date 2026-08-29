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
        assertEquals(3, args.getInt("protocol"))
        assertEquals("pixel-voice-setup", args.getJSONObject("peer").getString("id"))
        assertFalse(args.getJSONObject("peer").has("implements"))
        assertEquals("secret", args.getJSONObject("auth").getString("password"))
        assertFalse(args.getJSONObject("auth").has("token"))
        assertFalse(args.has("client"))
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
    fun validatesHumanPeerHandshakeAndIndependentGrants() {
        val result = VoiceProtocol.validateConnectResponse(
            JSONObject(
                """
                {
                  "ok":true,
                  "data":{
                    "protocol":3,
                    "peer":{
                      "id":"pixel-voice",
                      "sessionId":"session-1",
                      "principal":{"kind":"human","account":{"uid":1000}},
                      "grant":{
                        "calls":["conversation.*","ai.transcription.create"],
                        "signals":["message.committed","proc.run.hil.requested"],
                        "implements":[]
                      }
                    }
                  }
                }
                """.trimIndent(),
            ),
            "pixel-voice",
        )

        assertEquals(1000, result.uid)
        assertTrue("conversation.*" in result.calls)
        assertTrue("message.committed" in result.signals)
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

    @Test
    fun consumesOnlyDirectedShipMessagesAsVoiceAnswers() {
        val directed = JSONObject(
            """
            {
              "type":"sig",
              "signal":"message.committed",
              "payload":{
                "directed":true,
                "message":{
                  "conversationId":"ship-1",
                  "processId":"pid-1",
                  "runId":"run-1",
                  "author":{"kind":"process","pid":"pid-1","uid":1000},
                  "text":"The answer"
                }
              }
            }
            """.trimIndent(),
        )
        val event = VoiceProtocol.parseTerminalSignal(directed, "ship-1", "pid-1")

        assertEquals("run-1", event?.runId)
        assertEquals(VoiceRunTerminal.Answer("The answer"), event?.terminal)

        directed.getJSONObject("payload").put("directed", false)
        assertNull(VoiceProtocol.parseTerminalSignal(directed, "ship-1", "pid-1"))

        directed.getJSONObject("payload")
            .put("directed", true)
            .getJSONObject("message")
            .put("processId", "another-pid")
        assertNull(VoiceProtocol.parseTerminalSignal(directed, "ship-1", "pid-1"))
    }

    @Test
    fun scopesAbortedVoiceRunsToTheShipHandler() {
        val aborted = JSONObject(
            """
            {
              "type":"sig",
              "signal":"message.aborted",
              "payload":{
                "conversationId":"ship-1",
                "processId":"pid-1",
                "runId":"run-1",
                "reason":"superseded"
              }
            }
            """.trimIndent(),
        )

        val event = VoiceProtocol.parseTerminalSignal(aborted, "ship-1", "pid-1")
        assertEquals("run-1", event?.runId)
        assertTrue(event?.terminal is VoiceRunTerminal.Finished)

        aborted.getJSONObject("payload").put("processId", "another-pid")
        assertNull(VoiceProtocol.parseTerminalSignal(aborted, "ship-1", "pid-1"))
    }

    @Test
    fun classifiesOnlyBoundedProcessActivityWithoutRetainingArguments() {
        val syscalls = mapOf(
            "fs.read" to AssistantActivity.READING,
            "fs.write" to AssistantActivity.WRITING,
            "fs.edit" to AssistantActivity.WRITING,
            "fs.search" to AssistantActivity.SEARCHING,
            "shell.exec" to AssistantActivity.EXECUTING,
            "codemode.exec" to AssistantActivity.EXECUTING,
            "fs.delete" to AssistantActivity.DELETING,
            "net.fetch" to null,
        )

        syscalls.forEach { (syscall, expected) ->
            val signal = processSignal("proc.run.tool.started")
            signal.getJSONObject("payload")
                .put("executionId", "execution-$syscall")
                .put("callId", "call-$syscall")
                .put("syscall", syscall)
                .put("args", JSONObject().put("private", "discard me"))

            val event = VoiceProtocol.parseProcessEvent(signal, "pid-1")
                as VoiceProcessEvent.ToolStarted
            assertEquals(expected, event.activity)
        }
    }

    @Test
    fun rejectsUnscopedOrMalformedProcessActivity() {
        val wrongProcess = processSignal("proc.run.started")
        assertNull(VoiceProtocol.parseProcessEvent(wrongProcess, "another-pid"))

        val malformedFinish = processSignal("proc.run.tool.finished")
        malformedFinish.getJSONObject("payload")
            .put("executionId", "execution-1")
            .put("callId", "call-1")
            .put("outcome", "maybe")
        assertNull(VoiceProtocol.parseProcessEvent(malformedFinish, "pid-1"))
    }

    private fun processSignal(signal: String): JSONObject = JSONObject()
        .put("type", "sig")
        .put("signal", signal)
        .put(
            "payload",
            JSONObject()
                .put("pid", "pid-1")
                .put("runId", "run-1"),
        )
}
