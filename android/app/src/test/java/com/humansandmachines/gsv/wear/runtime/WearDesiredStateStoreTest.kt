package com.humansandmachines.gsv.wear.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WearDesiredStateStoreTest {
    @Test
    fun missingOrUnknownStateFailsClosed() {
        assertEquals(DesiredWearState.DISARMED, DesiredWearState.decode(null))
        assertEquals(DesiredWearState.DISARMED, DesiredWearState.decode("unknown"))
        assertFalse(DesiredWearState.DISARMED.restoresRuntime)
    }

    @Test
    fun armedAndPausedStatesRestore() {
        assertEquals(DesiredWearState.ARMED, DesiredWearState.decode("ARMED"))
        assertEquals(DesiredWearState.PAUSED, DesiredWearState.decode("PAUSED"))
        assertTrue(DesiredWearState.ARMED.restoresRuntime)
        assertTrue(DesiredWearState.PAUSED.restoresRuntime)
    }

    @Test
    fun disarmRemovesThePersistedRestoreState() {
        val storage = FakeStorage("ARMED")
        val store = WearDesiredStateStore(storage)

        assertTrue(store.save(DesiredWearState.DISARMED))

        assertEquals(null, storage.value)
        assertEquals(DesiredWearState.DISARMED, store.load())
    }

    @Test
    fun storageFailureFailsClosedOnReadAndReportsFailedWrite() {
        val store = WearDesiredStateStore(FailingStorage)

        assertEquals(DesiredWearState.DISARMED, store.load())
        assertFalse(store.save(DesiredWearState.ARMED))
    }

    private class FakeStorage(var value: String?) : WearDesiredStateStorage {
        override fun read(): String? = value

        override fun write(value: String?): Boolean {
            this.value = value
            return true
        }
    }

    private object FailingStorage : WearDesiredStateStorage {
        override fun read(): String? = error("storage unavailable")

        override fun write(value: String?): Boolean = error("storage unavailable")
    }
}
