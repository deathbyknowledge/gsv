package com.humansandmachines.gsv.wear.voice

import android.app.role.RoleManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.service.voice.VoiceInteractionService

object AndroidAssistantRole {
    fun isSelected(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roles = context.getSystemService(RoleManager::class.java)
            if (roles.isRoleAvailable(RoleManager.ROLE_ASSISTANT)) {
                return roles.isRoleHeld(RoleManager.ROLE_ASSISTANT)
            }
        }
        return VoiceInteractionService.isActiveService(
            context,
            ComponentName(context, GsvVoiceInteractionService::class.java),
        )
    }

    fun requestIntent(context: Context): Intent {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roles = context.getSystemService(RoleManager::class.java)
            if (roles.isRoleAvailable(RoleManager.ROLE_ASSISTANT)) {
                return roles.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT)
            }
        }
        return Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)
    }
}
