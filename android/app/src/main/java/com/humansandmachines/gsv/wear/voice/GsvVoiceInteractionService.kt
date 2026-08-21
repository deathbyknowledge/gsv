package com.humansandmachines.gsv.wear.voice

import android.content.Intent
import android.service.voice.VoiceInteractionService

class GsvVoiceInteractionService : VoiceInteractionService() {
    override fun onLaunchVoiceAssistFromKeyguard() {
        startActivity(
            Intent(this, VoiceAssistantActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION),
        )
    }
}
