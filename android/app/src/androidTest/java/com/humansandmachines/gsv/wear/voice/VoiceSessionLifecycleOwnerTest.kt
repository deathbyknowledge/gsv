package com.humansandmachines.gsv.wear.voice

import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class VoiceSessionLifecycleOwnerTest {
    @Test
    fun followsRepeatedSessionVisibility() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val owner = VoiceSessionLifecycleOwner()

            owner.create()
            assertEquals(Lifecycle.State.CREATED, owner.lifecycle.currentState)

            owner.show()
            assertEquals(Lifecycle.State.RESUMED, owner.lifecycle.currentState)

            owner.hide()
            assertEquals(Lifecycle.State.CREATED, owner.lifecycle.currentState)

            owner.show()
            assertEquals(Lifecycle.State.RESUMED, owner.lifecycle.currentState)

            owner.destroy()
            assertEquals(Lifecycle.State.DESTROYED, owner.lifecycle.currentState)
        }
    }
}
