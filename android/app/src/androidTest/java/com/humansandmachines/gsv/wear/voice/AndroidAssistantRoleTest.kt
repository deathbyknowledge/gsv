package com.humansandmachines.gsv.wear.voice

import android.app.role.RoleManager
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.service.voice.VoiceInteractionService
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidAssistantRoleTest {
    @Test
    fun installedVoiceServiceQualifiesForTheAssistantRoleRequest() {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val roles = context.getSystemService(RoleManager::class.java)
        assumeTrue(roles.isRoleAvailable(RoleManager.ROLE_ASSISTANT))

        val services = context.packageManager.queryIntentServices(
            Intent(VoiceInteractionService.SERVICE_INTERFACE).setPackage(context.packageName),
            0,
        )
        assertTrue(services.any { it.serviceInfo.name == GsvVoiceInteractionService::class.java.name })

        val request = AndroidAssistantRole.requestIntent(context)
        assertNotEquals(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS, request.action)
        assertNotNull(context.packageManager.resolveActivity(request, 0))
        assertEquals(
            roles.isRoleHeld(RoleManager.ROLE_ASSISTANT),
            AndroidAssistantRole.isSelected(context),
        )
    }
}
