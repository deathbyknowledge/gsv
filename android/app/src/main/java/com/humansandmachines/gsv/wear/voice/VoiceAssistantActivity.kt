package com.humansandmachines.gsv.wear.voice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.humansandmachines.gsv.wear.R
import com.humansandmachines.gsv.wear.ui.AssistantSurface
import com.humansandmachines.gsv.wear.ui.detailText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class VoiceAssistantActivity : ComponentActivity() {
    private var setup: Job? = null
    private var turn: Job? = null
    private var stopReceiverRegistered = false
    private var assistantState by mutableStateOf(VoiceTurnState.PREPARING)
    private var assistantDetail by mutableStateOf("")
    private val stopVoiceCommandReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == ACTION_STOP_VOICE_COMMAND) finishVoiceCommand()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        }
        assistantDetail = VoiceTurnState.PREPARING.detailText(this)
        setContent {
            val runtime by AssistantRuntimeState.snapshot.collectAsStateWithLifecycle()
            AssistantSurface(
                state = assistantState,
                detail = assistantDetail,
                signal = runtime.level,
                activity = if (assistantState == VoiceTurnState.THINKING) {
                    runtime.activity
                } else {
                    AssistantActivity.NONE
                },
                onCancel = ::finishVoiceCommand,
            )
        }
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
        updateState(VoiceTurnState.PREPARING)
        setup = lifecycleScope.launch {
            val captureRoute = if (intent.action == Intent.ACTION_VOICE_COMMAND) {
                try {
                    HeadsetVoiceCommandSession.open(this@VoiceAssistantActivity, intent)
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    assistantState = VoiceTurnState.ERROR
                    assistantDetail = getString(R.string.voice_headset_error)
                    delay(1_500)
                    finish()
                    return@launch
                }
            } else {
                null
            }
            turn = VoiceAssistantRuntime.startTurn(
                scope = lifecycleScope,
                onState = ::updateState,
                onFinished = { finish() },
                captureRoute = captureRoute,
            )
        }
    }

    private fun updateState(state: VoiceTurnState) {
        assistantState = state
        assistantDetail = state.detailText(this)
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
