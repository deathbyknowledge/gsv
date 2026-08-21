package com.humansandmachines.gsv.wear.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationAccessStatusTest {
    @Test
    fun explainsTheSpecialAccessGrantWhenMissing() {
        val status = notificationAccessStatus(granted = false, connected = false)

        assertFalse(status.getBoolean("usable"))
        assertTrue(status.getBoolean("setupRequired"))
        assertTrue(status.getString("detail").contains("Notification access"))
        assertEquals(
            "android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS",
            status.getString("settingsAction"),
        )
    }

    @Test
    fun distinguishesGrantedFromConnected() {
        val connecting = notificationAccessStatus(granted = true, connected = false)
        val ready = notificationAccessStatus(granted = true, connected = true)

        assertFalse(connecting.getBoolean("setupRequired"))
        assertFalse(connecting.getBoolean("usable"))
        assertTrue(ready.getBoolean("usable"))
    }
}
