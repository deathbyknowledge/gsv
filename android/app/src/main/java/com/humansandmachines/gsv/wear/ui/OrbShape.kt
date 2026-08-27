package com.humansandmachines.gsv.wear.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector4D
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.spring
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember

@Immutable
internal data class OrbShapeParameters(
    val organicAmount: Float,
    val symbolPresence: Float,
    val eyeSpacing: Float,
    val smileCurve: Float,
)

enum class OrbShapeTarget(
    internal val parameters: OrbShapeParameters,
) {
    LISTENING(
        OrbShapeParameters(
            organicAmount = 1f,
            symbolPresence = 0f,
            eyeSpacing = 0.12f,
            smileCurve = 0.92f,
        ),
    ),
    SMILE(
        OrbShapeParameters(
            organicAmount = 0f,
            symbolPresence = 1f,
            eyeSpacing = 0.115f,
            smileCurve = 1f,
        ),
    ),
}

private val OrbShapeVectorConverter = TwoWayConverter<OrbShapeParameters, AnimationVector4D>(
    convertToVector = { parameters ->
        AnimationVector4D(
            parameters.organicAmount,
            parameters.symbolPresence,
            parameters.eyeSpacing,
            parameters.smileCurve,
        )
    },
    convertFromVector = { vector ->
        OrbShapeParameters(
            organicAmount = vector.v1,
            symbolPresence = vector.v2,
            eyeSpacing = vector.v3,
            smileCurve = vector.v4,
        )
    },
)

@Composable
internal fun rememberOrbShapeParameters(target: OrbShapeTarget): OrbShapeParameters {
    val animated = remember {
        Animatable(
            initialValue = target.parameters,
            typeConverter = OrbShapeVectorConverter,
            label = "assistant-orb-shape",
        )
    }
    LaunchedEffect(target) {
        animated.animateTo(
            targetValue = target.parameters,
            animationSpec = spring(
                dampingRatio = 0.86f,
                stiffness = 44f,
            ),
        )
    }
    return animated.value
}
