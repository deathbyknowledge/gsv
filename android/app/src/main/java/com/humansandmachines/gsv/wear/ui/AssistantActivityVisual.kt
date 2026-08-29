package com.humansandmachines.gsv.wear.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import com.humansandmachines.gsv.wear.voice.AssistantActivity
import kotlin.math.abs
import kotlin.math.sin

@Immutable
internal data class AssistantActivityParameters(
    val reading: Float = 0f,
    val searching: Float = 0f,
    val writing: Float = 0f,
    val executing: Float = 0f,
    val delegating: Float = 0f,
    val deleting: Float = 0f,
    val shredding: Float = 0f,
) {
    val presence: Float
        get() = totalWeight().coerceIn(0f, 1f)

    fun energy(loopPhase: Float): Float {
        val total = totalWeight()
        if (total <= 0.001f) return 0f
        return (
            reading * activityEnergy(AssistantActivity.READING, loopPhase) +
                searching * activityEnergy(AssistantActivity.SEARCHING, loopPhase) +
                writing * activityEnergy(AssistantActivity.WRITING, loopPhase) +
                executing * activityEnergy(AssistantActivity.EXECUTING, loopPhase) +
                delegating * delegatingEnergy(loopPhase) +
                (deleting + shredding) * activityEnergy(AssistantActivity.DELETING, loopPhase)
        ) / total
    }

    private fun totalWeight(): Float =
        reading + searching + writing + executing + delegating + deleting + shredding
}

@Immutable
internal data class AssistantActivityRecipe(
    val accent: Color,
    val shape: OrbShapeParameters,
    val behavior: AssistantLiquidParameters,
    val parameters: AssistantActivityParameters,
)

@Composable
internal fun rememberAssistantActivityParameters(
    activity: AssistantActivity,
): AssistantActivityParameters {
    val target = activity.visualRecipe()?.parameters ?: AssistantActivityParameters()
    val reading by animateActivityChannel(target.reading, "assistant-activity-reading")
    val searching by animateActivityChannel(target.searching, "assistant-activity-searching")
    val writing by animateActivityChannel(target.writing, "assistant-activity-writing")
    val executing by animateActivityChannel(target.executing, "assistant-activity-executing")
    val delegating by animateActivityChannel(target.delegating, "assistant-activity-delegating")
    val deleting by animateActivityChannel(target.deleting, "assistant-activity-deleting")
    val shredding by animateActivityChannel(target.shredding, "assistant-activity-shredding")
    return AssistantActivityParameters(
        reading = reading,
        searching = searching,
        writing = writing,
        executing = executing,
        delegating = delegating,
        deleting = deleting,
        shredding = shredding,
    )
}

@Composable
private fun animateActivityChannel(target: Float, label: String) = animateFloatAsState(
    targetValue = target,
    animationSpec = tween(ACTIVITY_MORPH_MILLIS, easing = FastOutSlowInEasing),
    label = label,
)

internal fun AssistantActivity.visualRecipe(): AssistantActivityRecipe? {
    val shape = when (this) {
        AssistantActivity.NONE -> return null
        AssistantActivity.READING -> 0.78f
        AssistantActivity.WRITING -> 0.80f
        AssistantActivity.SEARCHING -> 0.84f
        AssistantActivity.EXECUTING -> 0.86f
        AssistantActivity.DELETING -> 0.82f
    }
    val behavior = when (this) {
        AssistantActivity.NONE -> return null
        AssistantActivity.READING -> AssistantLiquidParameters(0.34f, 0.38f, 0.72f, 0f)
        AssistantActivity.WRITING -> AssistantLiquidParameters(0.38f, 0.46f, 0.86f, 0f)
        AssistantActivity.SEARCHING -> AssistantLiquidParameters(0.40f, 0.54f, 0.84f, 0f)
        AssistantActivity.EXECUTING -> AssistantLiquidParameters(0.36f, 0.62f, 0.92f, 0f)
        AssistantActivity.DELETING -> AssistantLiquidParameters(0.50f, 0.58f, 0.94f, 0f)
    }
    return AssistantActivityRecipe(
        accent = accentColor(),
        shape = OrbShapeParameters(shape, 0f, 0f, 0.92f),
        behavior = behavior,
        parameters = when (this) {
            AssistantActivity.NONE -> AssistantActivityParameters()
            AssistantActivity.READING -> AssistantActivityParameters(reading = 1f)
            AssistantActivity.WRITING -> AssistantActivityParameters(writing = 1f)
            AssistantActivity.SEARCHING -> AssistantActivityParameters(searching = 1f)
            AssistantActivity.EXECUTING -> AssistantActivityParameters(executing = 1f)
            AssistantActivity.DELETING -> AssistantActivityParameters(shredding = 1f)
        },
    )
}

internal fun AssistantActivity.accentColor(): Color = when (this) {
    AssistantActivity.NONE -> GsvColor.Accent
    AssistantActivity.READING -> Color(0xFF98B5FF)
    AssistantActivity.WRITING -> Color(0xFFD19CFF)
    AssistantActivity.SEARCHING -> Color(0xFF87C2FF)
    AssistantActivity.EXECUTING -> Color(0xFFB58FFF)
    AssistantActivity.DELETING -> Color(0xFFB091FF)
}

internal fun AssistantActivity.stateLabel(): String = when (this) {
    AssistantActivity.NONE -> ""
    AssistantActivity.READING -> "READING"
    AssistantActivity.WRITING -> "WRITING"
    AssistantActivity.SEARCHING -> "SEARCHING"
    AssistantActivity.EXECUTING -> "EXECUTING"
    AssistantActivity.DELETING -> "DELETING"
}

private fun activityEnergy(activity: AssistantActivity, loopPhase: Float): Float = when (activity) {
    AssistantActivity.NONE -> 0f
    AssistantActivity.READING ->
        0.18f + 0.10f * abs(sin(loopPhase * 3f)) +
            0.04f * abs(sin(loopPhase * 5f + 0.7f))
    AssistantActivity.WRITING ->
        0.22f + 0.12f * abs(sin(loopPhase * 4f)) +
            0.07f * abs(sin(loopPhase * 9f + 0.5f))
    AssistantActivity.SEARCHING ->
        0.24f + 0.13f * abs(sin(loopPhase * 3f)) +
            0.08f * abs(sin(loopPhase * 8f + 0.8f))
    AssistantActivity.EXECUTING ->
        0.34f + 0.18f * abs(sin(loopPhase * 4f)) +
            0.08f * abs(sin(loopPhase * 7f + 0.4f))
    AssistantActivity.DELETING ->
        0.30f + 0.15f * abs(sin(loopPhase * 4f)) +
            0.08f * abs(sin(loopPhase * 9f + 0.4f))
}

private fun delegatingEnergy(loopPhase: Float): Float =
    0.28f + 0.14f * abs(sin(loopPhase * 3f)) +
        0.06f * abs(sin(loopPhase * 7f + 0.6f))

private const val ACTIVITY_MORPH_MILLIS = 720
