package com.humansandmachines.gsv.wear.provisioning

import com.humansandmachines.gsv.wear.voice.VoiceClientFailure
import com.humansandmachines.gsv.wear.voice.VoiceResponse
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ProvisioningProtocolTest {
    @Test
    fun driverRequestIsBoundToTheGeneratedPhoneIdentity() {
        val args = ProvisioningProtocol.driverTokenArgs("android-pixel-a1b2", "Pixel 10")

        assertEquals("node", args.getString("kind"))
        assertEquals("driver", args.getString("allowedRole"))
        assertEquals("android-pixel-a1b2", args.getString("allowedDeviceId"))
    }

    @Test
    fun issuedDriverMustConfirmItsBinding() {
        val issued = ProvisioningProtocol.parseIssued(
            VoiceResponse(
                JSONObject().put(
                    "token",
                    JSONObject()
                        .put("tokenId", "token-1")
                        .put("token", "secret")
                        .put("kind", "node")
                        .put("allowedRole", "driver")
                        .put("allowedDeviceId", "another-phone"),
                ),
            ),
        )

        assertThrows(VoiceClientFailure::class.java) {
            ProvisioningProtocol.requireDriver(issued, "android-pixel-a1b2")
        }
    }

    @Test
    fun assistantCredentialMustRemainAUserCredential() {
        val issued = ProvisioningProtocol.parseIssued(
            VoiceResponse(
                JSONObject().put(
                    "token",
                    JSONObject()
                        .put("tokenId", "token-2")
                        .put("token", "secret")
                        .put("kind", "user")
                        .put("allowedRole", "user")
                        .put("allowedDeviceId", JSONObject.NULL),
                ),
            ),
        )

        ProvisioningProtocol.requireVoice(issued)
    }
}
