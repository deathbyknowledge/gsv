package com.humansandmachines.gsv.wear.voice

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class VoiceClientSessionTest {
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
    fun observesShipBeforeBecomingReadyAndPublishesSanitizedActivity() = runBlocking {
        val calls = CopyOnWriteArrayList<JSONObject>()
        val reading = CompletableDeferred<AssistantProcessState>()
        server.enqueue(MockResponse().withWebSocketUpgrade(shipGateway(calls)))
        val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()
        val session = VoiceClientSession(
            epoch = 7L,
            config = VoiceSessionConfig(
                gatewayUrl = server.url("/ws").toString().replaceFirst("http://", "ws://"),
                username = "alice",
                clientId = "pixel-mind",
                credential = VoiceCredential.Token("assistant-token"),
            ),
            client = client,
            scope = this,
            discoverPersonalProcess = true,
            onReady = {},
            onProcessState = { epoch, state ->
                if (epoch == 7L && state.activity == AssistantActivity.READING) {
                    reading.complete(state)
                }
            },
            onTerminated = { _, _ -> },
        )

        try {
            session.open()
            session.awaitReady()
            val state = withTimeout(3_000L) { reading.await() }

            assertTrue(state.active)
            assertEquals(AssistantActivity.READING, state.activity)
            assertEquals(
                listOf("sys.connect", "conversation.ship", "proc.observe"),
                calls.take(3).map { it.getString("call") },
            )
            assertEquals("pid-ship", calls[2].getJSONObject("args").getString("pid"))
        } finally {
            session.close()
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
        }
    }

    @Test
    fun replacesTheObservationWhenTheCanonicalShipHandlerExits() = runBlocking {
        val calls = CopyOnWriteArrayList<JSONObject>()
        val replacementObserved = CompletableDeferred<Unit>()
        val oldObservationRemoved = CompletableDeferred<Unit>()
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                replacingShipGateway(calls, replacementObserved, oldObservationRemoved),
            ),
        )
        val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()
        val session = VoiceClientSession(
            epoch = 8L,
            config = VoiceSessionConfig(
                gatewayUrl = server.url("/ws").toString().replaceFirst("http://", "ws://"),
                username = "alice",
                clientId = "pixel-mind",
                credential = VoiceCredential.Token("assistant-token"),
            ),
            client = client,
            scope = this,
            discoverPersonalProcess = true,
            onReady = {},
            onTerminated = { _, _ -> },
        )

        try {
            session.open()
            session.awaitReady()
            withTimeout(3_000L) { replacementObserved.await() }
            withTimeout(3_000L) { oldObservationRemoved.await() }

            assertEquals(
                listOf("pid-old", "pid-new"),
                calls.filter { it.getString("call") == "proc.observe" }
                    .map { it.getJSONObject("args").getString("pid") },
            )
            assertEquals("pid-new", session.shipHandlerPid)
        } finally {
            session.close()
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
        }
    }

    private fun shipGateway(calls: MutableList<JSONObject>): WebSocketListener =
        object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val request = JSONObject(text)
                if (request.optString("type") != "req") return
                calls += request
                val id = request.getString("id")
                when (request.getString("call")) {
                    "sys.connect" -> webSocket.send(
                        success(id, connectData()).toString(),
                    )
                    "conversation.ship" -> webSocket.send(
                        success(
                            id,
                            JSONObject().put(
                                "conversation",
                                JSONObject()
                                    .put("id", "conversation-ship")
                                    .put("kind", "ship")
                                    .put("ownerUid", 1000)
                                    .put("handlerPid", "pid-ship"),
                            ),
                        ).toString(),
                    )
                    "proc.observe" -> {
                        webSocket.send(success(id, JSONObject().put("ok", true)).toString())
                        webSocket.send(processSignal("proc.run.started").toString())
                        webSocket.send(
                            processSignal("proc.run.tool.started")
                                .also { frame ->
                                    frame.getJSONObject("payload")
                                        .put("executionId", "execution-read")
                                        .put("callId", "call-read")
                                        .put("name", "Read")
                                        .put("syscall", "fs.read")
                                        .put("args", JSONObject().put("path", "/private/file"))
                                }
                                .toString(),
                        )
                    }
                }
            }
        }

    private fun replacingShipGateway(
        calls: MutableList<JSONObject>,
        replacementObserved: CompletableDeferred<Unit>,
        oldObservationRemoved: CompletableDeferred<Unit>,
    ): WebSocketListener {
        val shipResolutions = AtomicInteger()
        return object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val request = JSONObject(text)
                if (request.optString("type") != "req") return
                calls += request
                val id = request.getString("id")
                when (request.getString("call")) {
                    "sys.connect" -> webSocket.send(success(id, connectData()).toString())
                    "conversation.ship" -> {
                        val handler = if (shipResolutions.getAndIncrement() == 0) {
                            "pid-old"
                        } else {
                            "pid-new"
                        }
                        webSocket.send(
                            success(
                                id,
                                JSONObject().put(
                                    "conversation",
                                    JSONObject()
                                        .put("id", "conversation-ship")
                                        .put("kind", "ship")
                                        .put("ownerUid", 1000)
                                        .put("handlerPid", handler),
                                ),
                            ).toString(),
                        )
                    }
                    "proc.observe" -> {
                        val pid = request.getJSONObject("args").getString("pid")
                        webSocket.send(success(id, JSONObject().put("ok", true)).toString())
                        if (pid == "pid-old") {
                            webSocket.send(
                                JSONObject()
                                    .put("type", "sig")
                                    .put("signal", "process.exit")
                                    .put("payload", JSONObject().put("pid", "pid-old"))
                                    .toString(),
                            )
                        } else {
                            replacementObserved.complete(Unit)
                        }
                    }
                    "proc.unobserve" -> {
                        webSocket.send(success(id, JSONObject().put("ok", true)).toString())
                        if (request.getJSONObject("args").getString("pid") == "pid-old") {
                            oldObservationRemoved.complete(Unit)
                        }
                    }
                }
            }
        }
    }

    private fun connectData(): JSONObject = JSONObject()
        .put("protocol", 3)
        .put(
            "peer",
            JSONObject()
                .put("id", "pixel-mind")
                .put(
                    "principal",
                    JSONObject()
                        .put("kind", "human")
                        .put("account", JSONObject().put("uid", 1000)),
                )
                .put(
                    "grant",
                    JSONObject()
                        .put(
                            "calls",
                            JSONArray(
                                listOf(
                                    "conversation.ship",
                                    "conversation.send",
                                    "ai.transcription.create",
                                    "proc.observe",
                                    "proc.unobserve",
                                ),
                            ),
                        )
                        .put(
                            "signals",
                            JSONArray(
                                listOf(
                                    "message.committed",
                                    "message.aborted",
                                    "proc.run.started",
                                    "proc.run.stream",
                                    "proc.run.retrying",
                                    "proc.run.output",
                                    "proc.run.tool.started",
                                    "proc.run.tool.finished",
                                    "proc.run.hil.requested",
                                    "proc.run.finished",
                                    "process.exit",
                                ),
                            ),
                        ),
                ),
        )

    private fun processSignal(signal: String): JSONObject = JSONObject()
        .put("type", "sig")
        .put("signal", signal)
        .put(
            "payload",
            JSONObject()
                .put("pid", "pid-ship")
                .put("runId", "run-1"),
        )

    private fun success(id: String, data: JSONObject): JSONObject = JSONObject()
        .put("type", "res")
        .put("id", id)
        .put("ok", true)
        .put("data", data)
}
