package com.humansandmachines.gsv.wear.voice

import android.content.Context
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class GsvVoiceInteractionSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession =
        GsvVoiceInteractionSession(this)
}

private class GsvVoiceInteractionSession(context: Context) : VoiceInteractionSession(context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var turn: Job? = null

    override fun onCreate() {
        super.onCreate()
        setUiEnabled(false)
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        turn = VoiceAssistantRuntime.startTurn(
            scope = scope,
            onFinished = { runCatching(::finish) },
        )
    }

    override fun onHide() {
        turn?.cancel()
        turn = null
        super.onHide()
    }

    override fun onDestroy() {
        turn?.cancel()
        scope.cancel()
        super.onDestroy()
    }
}
