package com.humansandmachines.gsv.wear.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OnboardingInputTest {
    @Test
    fun addressDerivesTheSecureGatewayTransport() {
        assertNull(OnboardingInput.addressError("mine.gsv.space"))
        assertEquals(
            "wss://mine.gsv.space/ws",
            OnboardingInput.gatewayUrl("mine.gsv.space", allowCleartext = false),
        )
    }

    @Test
    fun debugLoopbackAddressDerivesCleartextForAdbReverse() {
        assertEquals(
            "ws://localhost:8787/ws",
            OnboardingInput.gatewayUrl("localhost:8787", allowCleartext = true),
        )
        assertEquals(
            "wss://192.168.1.20:8787/ws",
            OnboardingInput.gatewayUrl("192.168.1.20:8787", allowCleartext = true),
        )
    }

    @Test
    fun loginAddressRejectsTransportSyntaxAndCredentials() {
        assertTrue(OnboardingInput.addressError("wss://example.test/ws")!!.contains("wss://"))
        assertTrue(OnboardingInput.addressError("example.test/ws")!!.contains("/ws"))
        assertTrue(OnboardingInput.addressError("alice@example.test")!!.contains("credentials"))
        assertTrue(OnboardingInput.addressError("example.test?token=nope")!!.contains("query"))
    }

    @Test
    fun storedTransportReturnsToTheUserFacingAddress() {
        assertEquals(
            "mine.gsv.space",
            OnboardingInput.addressFromGatewayUrl("wss://mine.gsv.space/ws"),
        )
        assertEquals(
            "localhost:8787",
            OnboardingInput.addressFromGatewayUrl("ws://localhost:8787/ws"),
        )
    }

    @Test
    fun automaticPhoneIdentityIsBoundedAndProtocolSafe() {
        val id = DriverConfigStore.automaticDeviceId("OnePlus CPH 2653 / Very Nice", "A1-B2_C3")

        assertEquals("android-oneplus-cph-2653-very-nice-a1b2c3", id)
        assertTrue(id.length <= 128)
        assertTrue(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$").matches(id))
    }
}
