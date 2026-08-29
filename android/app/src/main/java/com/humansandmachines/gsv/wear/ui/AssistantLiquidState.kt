package com.humansandmachines.gsv.wear.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector4D
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.spring
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import com.humansandmachines.gsv.wear.voice.VoiceTurnState

@Immutable
internal data class AssistantLiquidParameters(
    val focus: Float,
    val foldComplexity: Float,
    val internalActivity: Float,
    val projection: Float,
)

private enum class AssistantLiquidTarget(
    val parameters: AssistantLiquidParameters,
) {
    LISTENING(
        AssistantLiquidParameters(
            focus = 0f,
            foldComplexity = 0f,
            internalActivity = 0f,
            projection = 0f,
        ),
    ),
    THINKING(
        AssistantLiquidParameters(
            focus = 1f,
            foldComplexity = 1f,
            internalActivity = 1f,
            projection = 0f,
        ),
    ),
    SPEAKING(
        AssistantLiquidParameters(
            focus = 0f,
            foldComplexity = 0.32f,
            internalActivity = 0.82f,
            projection = 1f,
        ),
    ),
}

private val AssistantLiquidVectorConverter =
    TwoWayConverter<AssistantLiquidParameters, AnimationVector4D>(
        convertToVector = { parameters ->
            AnimationVector4D(
                parameters.focus,
                parameters.foldComplexity,
                parameters.internalActivity,
                parameters.projection,
            )
        },
        convertFromVector = { vector ->
            AssistantLiquidParameters(
                focus = vector.v1,
                foldComplexity = vector.v2,
                internalActivity = vector.v3,
                projection = vector.v4,
            )
        },
    )

internal fun VoiceTurnState.usesAssistantLiquid(): Boolean = when (this) {
    VoiceTurnState.IDLE,
    VoiceTurnState.PREPARING,
    VoiceTurnState.LISTENING,
    VoiceTurnState.THINKING,
    VoiceTurnState.SPEAKING,
    VoiceTurnState.ERROR,
    -> true
}

@Composable
internal fun rememberAssistantLiquidParameters(
    state: VoiceTurnState,
    overrideParameters: AssistantLiquidParameters? = null,
): AssistantLiquidParameters {
    val target = when (state) {
        VoiceTurnState.THINKING -> AssistantLiquidTarget.THINKING
        VoiceTurnState.SPEAKING -> AssistantLiquidTarget.SPEAKING
        else -> AssistantLiquidTarget.LISTENING
    }
    val targetParameters = overrideParameters ?: target.parameters
    val animated = remember {
        Animatable(
            initialValue = targetParameters,
            typeConverter = AssistantLiquidVectorConverter,
            label = "assistant-liquid-state",
        )
    }
    LaunchedEffect(targetParameters) {
        animated.animateTo(
            targetValue = targetParameters,
            animationSpec = spring(
                dampingRatio = 0.90f,
                stiffness = 30f,
            ),
        )
    }
    return animated.value
}
