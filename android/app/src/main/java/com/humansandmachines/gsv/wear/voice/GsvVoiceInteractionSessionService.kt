package com.humansandmachines.gsv.wear.voice

import android.content.Context
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.view.View
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.humansandmachines.gsv.wear.R
import com.humansandmachines.gsv.wear.ui.AssistantInvocationSurface
import com.humansandmachines.gsv.wear.ui.detailText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class GsvVoiceInteractionSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession =
        GsvVoiceInteractionSession(this)
}

private class GsvVoiceInteractionSession(
    private val sessionContext: Context,
) : VoiceInteractionSession(sessionContext) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val lifecycleOwner = VoiceSessionLifecycleOwner()
    private var turn: Job? = null
    private var state by mutableStateOf(VoiceTurnState.PREPARING)
    private var contentView: ComposeView? = null

    override fun onCreate() {
        setTheme(R.style.Theme_GsvWear_VoiceSession)
        super.onCreate()
        lifecycleOwner.create()
        setUiEnabled(true)
    }

    override fun onCreateContentView(): View = ComposeView(sessionContext).also { view ->
        contentView = view
        view.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        view.setViewTreeLifecycleOwner(lifecycleOwner)
        view.setViewTreeSavedStateRegistryOwner(lifecycleOwner)
        view.setViewTreeViewModelStoreOwner(lifecycleOwner)
        view.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
        view.setContent {
            val runtime by AssistantRuntimeState.snapshot.collectAsState()
            AssistantInvocationSurface(
                state = state,
                detail = state.detailText(sessionContext),
                signal = runtime.level,
                onCancel = ::cancelTurn,
            )
        }
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        lifecycleOwner.show()
        turn?.cancel()
        state = VoiceTurnState.PREPARING
        turn = VoiceAssistantRuntime.startTurn(
            scope = scope,
            onState = { state = it },
            onFinished = { runCatching(::finish) },
        )
    }

    override fun onComputeInsets(outInsets: Insets) {
        super.onComputeInsets(outInsets)
        val view = contentView ?: return
        val touchHeight = (480f * sessionContext.resources.displayMetrics.density).toInt()
        val touchTop = (view.height - touchHeight).coerceAtLeast(0)
        outInsets.touchableInsets = Insets.TOUCHABLE_INSETS_REGION
        outInsets.touchableRegion.set(0, touchTop, view.width, view.height)
    }

    override fun onHide() {
        turn?.cancel()
        turn = null
        lifecycleOwner.hide()
        super.onHide()
    }

    override fun onDestroy() {
        turn?.cancel()
        contentView = null
        lifecycleOwner.destroy()
        scope.cancel()
        super.onDestroy()
    }

    private fun cancelTurn() {
        turn?.cancel()
        turn = null
        finish()
    }
}

internal class VoiceSessionLifecycleOwner : LifecycleOwner, SavedStateRegistryOwner, ViewModelStoreOwner {
    private val registry = LifecycleRegistry(this)
    private val savedStateController = SavedStateRegistryController.create(this)

    override val lifecycle: Lifecycle = registry
    override val savedStateRegistry: SavedStateRegistry = savedStateController.savedStateRegistry
    override val viewModelStore = ViewModelStore()

    fun create() {
        savedStateController.performAttach()
        savedStateController.performRestore(null)
        registry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
    }

    fun show() {
        if (registry.currentState == Lifecycle.State.CREATED) {
            registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        }
        if (registry.currentState == Lifecycle.State.STARTED) {
            registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
        }
    }

    fun hide() {
        if (registry.currentState == Lifecycle.State.RESUMED) {
            registry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
        }
        if (registry.currentState == Lifecycle.State.STARTED) {
            registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        }
    }

    fun destroy() {
        hide()
        if (registry.currentState != Lifecycle.State.DESTROYED) {
            registry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)
        }
        viewModelStore.clear()
    }
}
