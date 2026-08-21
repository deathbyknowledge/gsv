package com.humansandmachines.gsv.wear.voice

import android.content.Intent
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

class GsvRecognitionService : RecognitionService() {
    override fun onStartListening(recognizerIntent: Intent, listener: Callback) {
        runCatching { listener.error(SpeechRecognizer.ERROR_CLIENT) }
    }

    override fun onCancel(listener: Callback) = Unit

    override fun onStopListening(listener: Callback) = Unit
}
