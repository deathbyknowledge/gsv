package com.humansandmachines.gsv.wear.voice

import android.content.Context
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.humansandmachines.gsv.wear.R
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class VoiceAssistantActivity : AppCompatActivity() {
    private lateinit var status: TextView
    private var setup: Job? = null
    private var turn: Job? = null
    private var stopReceiverRegistered = false
    private val stopVoiceCommandReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == ACTION_STOP_VOICE_COMMAND) finishVoiceCommand()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        }
        status = TextView(this).apply {
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            setTextColor(getColor(R.color.gsv_text))
            textSize = 22f
            text = getString(R.string.voice_preparing)
        }
        setContentView(status)
        startInvocation(intent)
    }

    override fun onStart() {
        super.onStart()
        ContextCompat.registerReceiver(
            this,
            stopVoiceCommandReceiver,
            IntentFilter(ACTION_STOP_VOICE_COMMAND),
            ContextCompat.RECEIVER_EXPORTED,
        )
        stopReceiverRegistered = true
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        startInvocation(intent)
    }

    override fun onStop() {
        if (stopReceiverRegistered) {
            unregisterReceiver(stopVoiceCommandReceiver)
            stopReceiverRegistered = false
        }
        super.onStop()
    }

    override fun onDestroy() {
        setup?.cancel()
        setup = null
        turn?.cancel()
        turn = null
        super.onDestroy()
    }

    private fun startInvocation(intent: Intent) {
        setup?.cancel()
        turn?.cancel()
        setup = lifecycleScope.launch {
            val captureRoute = if (intent.action == Intent.ACTION_VOICE_COMMAND) {
                try {
                    HeadsetVoiceCommandSession.open(this@VoiceAssistantActivity, intent)
                } catch (_: Exception) {
                    status.text = getString(R.string.voice_headset_error)
                    delay(1_500)
                    finish()
                    return@launch
                }
            } else {
                null
            }
            turn = VoiceAssistantRuntime.startTurn(
                scope = lifecycleScope,
                onState = { state -> status.text = state.displayText(this@VoiceAssistantActivity) },
                onFinished = { finish() },
                captureRoute = captureRoute,
            )
        }
    }

    private fun finishVoiceCommand() {
        setup?.cancel()
        turn?.cancel()
        finish()
    }

    companion object {
        private const val ACTION_STOP_VOICE_COMMAND = "android.intent.action.STOP_VOICE_COMMAND"
    }
}

fun VoiceTurnState.displayText(context: Context): String = context.getString(
    when (this) {
        VoiceTurnState.IDLE -> R.string.voice_ready
        VoiceTurnState.PREPARING -> R.string.voice_preparing
        VoiceTurnState.LISTENING -> R.string.voice_listening
        VoiceTurnState.TRANSCRIBING -> R.string.voice_transcribing
        VoiceTurnState.THINKING -> R.string.voice_thinking
        VoiceTurnState.SPEAKING -> R.string.voice_speaking
        VoiceTurnState.ERROR -> R.string.voice_error
    },
)
