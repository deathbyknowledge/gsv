package com.humansandmachines.gsv.wear.target

import java.util.Locale

internal fun parseDurationMillis(value: String, label: String): Long {
    val normalized = value.trim().lowercase(Locale.ROOT)
    val match = DURATION_PATTERN.matchEntire(normalized)
        ?: throw TargetFsException("$label must use ms, s, or m (for example 500ms or 5s)")
    val amount = match.groupValues[1].toLongOrNull()
        ?: throw TargetFsException("$label is too large")
    val multiplier = when (match.groupValues[2]) {
        "ms" -> 1L
        "s" -> 1_000L
        "m" -> 60_000L
        else -> throw TargetFsException("$label has an unsupported unit")
    }
    return try {
        Math.multiplyExact(amount, multiplier)
    } catch (_: ArithmeticException) {
        throw TargetFsException("$label is too large")
    }
}

internal fun shellJson(value: org.json.JSONObject): TargetCommandResult =
    TargetCommandResult(stdout = value.toString() + "\n")

private val DURATION_PATTERN = Regex("([0-9]+)(ms|s|m)")
