package com.humansandmachines.gsv.wear.runtime

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class WearRuntimeRestorationReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in RESTORE_ACTIONS) return
        WearRuntimeService.restoreIfDesired(context)
    }

    companion object {
        private val RESTORE_ACTIONS = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_USER_UNLOCKED,
        )
    }
}
