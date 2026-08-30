package com.humansandmachines.gsv.wear.runtime

import android.content.Context

internal enum class DesiredWearState {
    DISARMED,
    ARMED,
    PAUSED,
    ;

    val restoresRuntime: Boolean
        get() = this != DISARMED

    companion object {
        fun decode(value: String?): DesiredWearState =
            entries.firstOrNull { it.name == value } ?: DISARMED
    }
}

internal interface WearDesiredStateStorage {
    fun read(): String?

    fun write(value: String?): Boolean
}

internal class WearDesiredStateStore(
    private val storage: WearDesiredStateStorage,
) {
    constructor(context: Context) : this(SharedPreferencesWearDesiredStateStorage(context))

    fun load(): DesiredWearState = runCatching {
        DesiredWearState.decode(storage.read())
    }.getOrDefault(DesiredWearState.DISARMED)

    fun save(state: DesiredWearState): Boolean = runCatching {
        storage.write(state.takeIf(DesiredWearState::restoresRuntime)?.name)
    }.getOrDefault(false)
}

private class SharedPreferencesWearDesiredStateStorage(context: Context) : WearDesiredStateStorage {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    override fun read(): String? = preferences.getString(KEY_DESIRED_STATE, null)

    override fun write(value: String?): Boolean {
        val editor = preferences.edit()
        if (value == null) {
            editor.remove(KEY_DESIRED_STATE)
        } else {
            editor.putString(KEY_DESIRED_STATE, value)
        }
        return editor.commit()
    }

    companion object {
        private const val PREFERENCES = "gsv_wear_runtime"
        private const val KEY_DESIRED_STATE = "desired_state"
    }
}
