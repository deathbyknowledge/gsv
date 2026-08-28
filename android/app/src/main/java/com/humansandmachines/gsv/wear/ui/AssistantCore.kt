package com.humansandmachines.gsv.wear.ui

import android.content.Context
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicText as Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.humansandmachines.gsv.wear.R
import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sin

@Composable
fun AssistantCore(
    state: VoiceTurnState,
    modifier: Modifier = Modifier,
    signal: Float = 0f,
    shapeTarget: OrbShapeTarget = OrbShapeTarget.LISTENING,
    accentOverride: Color? = null,
    shipOrbitRadians: Float = 0f,
    shipElevationOffsetRadians: Float = 0f,
    shipRenderMode: ShipRenderMode = ShipRenderMode.PHYSICAL,
    exposeStateSemantics: Boolean = true,
) {
    val phase = rememberVisualLoopFraction(
        durationNanos = ASSISTANT_LOOP_NANOS,
        frameIntervalNanos = assistantFrameIntervalNanos(state, shapeTarget),
    ) * ASSISTANT_LOOP_SECONDS
    val smoothedSignal by animateFloatAsState(
        targetValue = signal.coerceIn(0f, 1f),
        animationSpec = tween(90, easing = FastOutSlowInEasing),
        label = "assistant-signal",
    )
    val speakingEnvelope = remember { Animatable(0f) }
    val speakingTarget = if (state == VoiceTurnState.SPEAKING) {
        signal.coerceIn(0f, 1f)
    } else {
        0f
    }
    LaunchedEffect(state == VoiceTurnState.SPEAKING, speakingTarget) {
        val durationMillis = if (speakingTarget > speakingEnvelope.value) {
            SPEAKING_ATTACK_MILLIS
        } else {
            SPEAKING_RELEASE_MILLIS
        }
        speakingEnvelope.animateTo(
            targetValue = speakingTarget,
            animationSpec = tween(durationMillis, easing = LinearEasing),
        )
    }
    val accent by animateColorAsState(
        targetValue = accentOverride ?: state.accentColor(),
        animationSpec = tween(480, easing = FastOutSlowInEasing),
        label = "assistant-accent",
    )
    val shipMaterialization = remember {
        Animatable(if (shipRenderMode == ShipRenderMode.PHYSICAL) 1f else 0f)
    }
    LaunchedEffect(shipRenderMode) {
        val target = if (shipRenderMode == ShipRenderMode.PHYSICAL) 1f else 0f
        val remainingDistance = abs(target - shipMaterialization.value)
        shipMaterialization.animateTo(
            targetValue = target,
            animationSpec = tween(
                durationMillis = (
                    SHIP_MATERIALIZATION_MILLIS * remainingDistance
                ).roundToInt().coerceAtLeast(1),
                easing = LinearOutSlowInEasing,
            ),
        )
    }
    val shapeParameters = rememberOrbShapeParameters(shapeTarget)
    val liquidParameters = rememberAssistantLiquidParameters(state)
    val loopPhase = phase / 12f * PI.toFloat() * 2f
    val thinkingEnergy = 0.25f +
        0.11f * abs(sin(loopPhase * 2f)) +
        0.05f * abs(sin(loopPhase * 3f + 0.9f))
    val speakingEnergy = speakingEnvelope.value
    val receptiveEnergy = when (state) {
        VoiceTurnState.IDLE -> 0.06f
        VoiceTurnState.PREPARING -> 0.22f
        VoiceTurnState.ERROR -> 0.16f
        else -> smoothedSignal
    }
    val focusedEnergy = receptiveEnergy +
        (thinkingEnergy - receptiveEnergy) * liquidParameters.focus.coerceIn(0f, 1f)
    val energy = focusedEnergy +
        (speakingEnergy - focusedEnergy) * liquidParameters.projection.coerceIn(0f, 1f)

    val semanticsModifier = if (exposeStateSemantics) {
        Modifier.semantics {
            contentDescription = "GSV assistant ${state.stateLabel().lowercase()}"
        }
    } else {
        Modifier
    }
    Box(
        modifier = modifier.then(semanticsModifier),
        contentAlignment = Alignment.Center,
    ) {
        AssistantEnergyField(
            state = state,
            phaseSeconds = phase,
            energy = energy,
            accent = accent,
            shapeParameters = shapeParameters,
            liquidParameters = liquidParameters,
            shipOrbitRadians = shipOrbitRadians,
            shipElevationOffsetRadians = shipElevationOffsetRadians,
            shipMaterialization = shipMaterialization.value,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

private const val SPEAKING_ATTACK_MILLIS = 240
private const val SPEAKING_RELEASE_MILLIS = 520
private const val ASSISTANT_LOOP_SECONDS = 12f
private const val ASSISTANT_LOOP_NANOS = 12_000_000_000L

@Composable
fun AssistantSurface(
    state: VoiceTurnState,
    detail: String,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
    signal: Float = 0f,
    shapeTarget: OrbShapeTarget = OrbShapeTarget.LISTENING,
) {
    val phase = rememberVisualLoopFraction(
        durationNanos = ASSISTANT_LOOP_NANOS,
        frameIntervalNanos = assistantFrameIntervalNanos(state, shapeTarget),
    ) * ASSISTANT_LOOP_SECONDS
    Box(modifier.fillMaxSize().background(GsvColor.Void)) {
        AssistantBackdrop(state, phase, Modifier.fillMaxSize())
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(horizontal = 26.dp, vertical = 22.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            AssistantHeader(state)
            Spacer(Modifier.weight(1f))
            AssistantCore(
                state = state,
                signal = signal,
                shapeTarget = shapeTarget,
                modifier = Modifier.size(336.dp),
            )
            Spacer(Modifier.height(18.dp))
            AssistantStateCopy(state, detail)
            Spacer(Modifier.weight(1f))
            AssistantCancelControl(onCancel = onCancel)
        }
    }
}

@Composable
fun AssistantInvocationSurface(
    state: VoiceTurnState,
    detail: String,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
    signal: Float = 0f,
    shapeTarget: OrbShapeTarget = OrbShapeTarget.LISTENING,
    coreActionDescription: String = "Cancel assistant",
    coreActionLabel: String = "TAP CORE TO DISMISS",
) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(460.dp)
                .background(
                    Brush.verticalGradient(
                        colors = listOf(
                            Color.Transparent,
                            GsvColor.Void.copy(alpha = 0.54f),
                            GsvColor.Void.copy(alpha = 0.94f),
                        ),
                    ),
                ),
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 24.dp, vertical = 18.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                modifier = Modifier
                    .size(238.dp)
                    .semantics {
                        role = Role.Button
                        contentDescription = coreActionDescription
                    }
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = onCancel,
                    ),
            ) {
                AssistantCore(
                    state = state,
                    signal = signal,
                    shapeTarget = shapeTarget,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            AssistantStateCopy(state, detail, compact = true)
            Spacer(Modifier.height(12.dp))
            Text(
                text = coreActionLabel,
                style = GsvTextStyle.Kicker.copy(
                    color = GsvColor.MutedDark.copy(alpha = 0.86f),
                    fontSize = 8.sp,
                    letterSpacing = 1.7.sp,
                ),
            )
        }
    }
}

@Composable
private fun AssistantHeader(state: VoiceTurnState) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("GSV // ASSISTANT", style = GsvTextStyle.Kicker)
        Row(
            modifier = Modifier
                .clip(CircleShape)
                .border(1.dp, state.accentColor().copy(alpha = 0.28f), CircleShape)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            androidx.compose.foundation.Canvas(Modifier.size(5.dp)) {
                drawCircle(state.accentColor(), center = Offset(size.width / 2f, size.height / 2f))
            }
            Text(
                text = "PRIVATE CHANNEL",
                style = GsvTextStyle.Kicker.copy(
                    color = GsvColor.Muted,
                    fontSize = 8.sp,
                    letterSpacing = 1.2.sp,
                ),
            )
        }
    }
}

@Composable
private fun AssistantStateCopy(
    state: VoiceTurnState,
    detail: String,
    compact: Boolean = false,
) {
    Column(
        modifier = Modifier
            .widthIn(max = if (compact) 310.dp else 350.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(if (compact) 6.dp else 9.dp),
    ) {
        Text(
            text = state.stateLabel(),
            style = GsvTextStyle.Title.copy(
                color = state.accentColor(),
                fontSize = if (compact) 18.sp else 21.sp,
                letterSpacing = 0.2.sp,
                textAlign = TextAlign.Center,
            ),
        )
        Text(
            text = detail,
            style = GsvTextStyle.Body.copy(
                color = GsvColor.Muted.copy(alpha = if (compact) 0.88f else 1f),
                fontSize = if (compact) 12.sp else 14.sp,
                lineHeight = if (compact) 17.sp else 21.sp,
                textAlign = TextAlign.Center,
            ),
        )
    }
}

@Composable
private fun AssistantCancelControl(onCancel: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Column(
        modifier = Modifier
            .semantics {
                role = Role.Button
                contentDescription = "Cancel assistant"
            }
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onCancel,
            )
            .padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(CircleShape)
                .background(GsvColor.Deep.copy(alpha = 0.78f))
                .border(1.dp, GsvColor.MutedDark.copy(alpha = 0.82f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "×",
                style = GsvTextStyle.Title.copy(
                    color = GsvColor.Muted,
                    fontSize = 26.sp,
                    fontWeight = FontWeight.Light,
                    textAlign = TextAlign.Center,
                ),
            )
        }
        Text(
            text = "CANCEL",
            style = GsvTextStyle.Kicker.copy(
                color = GsvColor.MutedDark,
                fontSize = 8.sp,
                letterSpacing = 1.8.sp,
            ),
        )
    }
}

fun VoiceTurnState.stateLabel(): String = when (this) {
    VoiceTurnState.IDLE -> "Assistant ready"
    VoiceTurnState.PREPARING -> "Establishing neural link"
    VoiceTurnState.LISTENING -> "Listening"
    VoiceTurnState.THINKING -> "Agent is thinking"
    VoiceTurnState.SPEAKING -> "Responding"
    VoiceTurnState.ERROR -> "Link interrupted"
}

fun VoiceTurnState.detailText(context: Context): String = when (this) {
    VoiceTurnState.IDLE -> "Ready for your next command."
    VoiceTurnState.PREPARING -> "Securing a private voice channel…"
    VoiceTurnState.LISTENING -> "Speak naturally. Tap the core to stop."
    VoiceTurnState.THINKING -> "Your personal agent has the floor."
    VoiceTurnState.SPEAKING -> "Response routed to the active audio device."
    VoiceTurnState.ERROR -> context.getString(R.string.voice_error)
}

private fun VoiceTurnState.shortLabel(): String = when (this) {
    VoiceTurnState.IDLE -> "READY"
    VoiceTurnState.PREPARING -> "LINK"
    VoiceTurnState.LISTENING -> "VOICE"
    VoiceTurnState.THINKING -> "COGNITION"
    VoiceTurnState.SPEAKING -> "TRANSMIT"
    VoiceTurnState.ERROR -> "FAULT"
}

fun VoiceTurnState.accentColor(): Color = when (this) {
    VoiceTurnState.ERROR -> GsvColor.Red
    VoiceTurnState.THINKING -> GsvColor.Violet
    VoiceTurnState.SPEAKING -> GsvColor.Blue
    VoiceTurnState.IDLE -> GsvColor.Muted
    VoiceTurnState.PREPARING,
    VoiceTurnState.LISTENING,
    -> GsvColor.Accent
}
