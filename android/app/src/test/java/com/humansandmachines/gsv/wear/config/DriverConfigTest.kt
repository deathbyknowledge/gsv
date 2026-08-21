package com.humansandmachines.gsv.wear.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class DriverConfigTest {
    @Test
    fun acceptsSecureGatewayConnection() {
        val error = DriverConfig.validate(
            ConnectionFields("wss://example.gsv.dev/ws", "alice", "pixel-10"),
            "secret-token",
            allowCleartext = false,
        )

        assertNull(error)
    }

    @Test
    fun rejectsCleartextInReleaseConfiguration() {
        val error = DriverConfig.validate(
            ConnectionFields("ws://localhost:8787/ws", "alice", "pixel-10"),
            "secret-token",
            allowCleartext = false,
        )

        assertEquals("Gateway URL must use wss://", error)
    }

    @Test
    fun requiresTheGatewayWebSocketPath() {
        val error = DriverConfig.validate(
            ConnectionFields("wss://example.gsv.dev/", "alice", "pixel-10"),
            "secret-token",
            allowCleartext = false,
        )

        assertEquals("Gateway URL must end in /ws", error)
    }

    @Test
    fun stringRepresentationRedactsCredentialsAndGateway() {
        val config = DriverConfig(
            "wss://private.example/ws",
            "alice",
            "pixel-10",
            "very-secret-token",
        )

        val rendered = config.toString()
        assertFalse(rendered.contains("private.example"))
        assertFalse(rendered.contains("very-secret-token"))
    }
}
