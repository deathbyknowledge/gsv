package com.humansandmachines.gsv.wear.target

import com.humansandmachines.gsv.wear.authority.AuthorityLease
import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.platform.GsvPlatformOperations
import org.json.JSONObject

class PlatformAutomationCommands(
    private val platform: GsvPlatformOperations,
    private val authority: WearAuthority,
) {
    fun commands(): List<TargetCommand> = listOf(
        TargetCommand(
            name = "screen",
            description = "Inspect or capture the current Android display",
            usage = "screen status | screenshot [DESTINATION]",
            category = "android",
            run = ::screen,
        ),
        TargetCommand(
            name = "input",
            description = "Inject bounded touch, key, or text input through GSV OS",
            usage = INPUT_USAGE,
            category = "android",
            run = ::input,
        ),
    )

    private suspend fun screen(args: List<String>, context: TargetCommandContext): TargetCommandResult = when {
        args == listOf("status") -> {
            val status = platform.status
            val output = JSONObject()
                .put("available", platform.supportsAutomation())
                .put("apiVersion", status?.apiVersion)
                .put("serviceVersion", status?.serviceVersion)
                .put("screenshotPath", WearTargetRuntimeFiles.SCREEN_SCREENSHOT)
            if (platform.supportsAutomation()) {
                val size = platform.displaySize()
                output.put("width", size.width).put("height", size.height)
            }
            shellJson(output)
        }
        args.firstOrNull() == "screenshot" && args.size <= 2 -> {
            val destination = context.fileSystem.resolve(
                args.getOrNull(1) ?: "/tmp/screen/screenshot-${context.nowMillis()}.png",
                context.cwd,
            )
            context.fileSystem.open(WearTargetRuntimeFiles.SCREEN_SCREENSHOT).use { capture ->
                capture.open().use { input ->
                    context.fileSystem.write(destination, input, capture.length, capture.contentType)
                }
            }
            val stat = context.fileSystem.stat(destination)
            shellJson(
                JSONObject()
                    .put("path", destination)
                    .put("size", stat.size)
                    .put("contentType", stat.contentType),
            )
        }
        else -> usage("screen status | screenshot [DESTINATION]")
    }

    private suspend fun input(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        requirePlatform()
        val lease = acquireLease()
        val output = when {
            args.size == 3 && args[0] == "tap" -> {
                val x = coordinate(args[1], "tap x")
                val y = coordinate(args[2], "tap y")
                platform.tap(x, y)
                JSONObject().put("injected", true).put("gesture", "tap").put("x", x).put("y", y)
            }
            args.size == 6 && args[0] == "swipe" -> {
                val startX = coordinate(args[1], "swipe start x")
                val startY = coordinate(args[2], "swipe start y")
                val endX = coordinate(args[3], "swipe end x")
                val endY = coordinate(args[4], "swipe end y")
                val duration = parseDurationMillis(args[5], "swipe duration")
                if (duration > Int.MAX_VALUE) throw TargetFsException("Swipe duration is too large")
                platform.swipe(startX, startY, endX, endY, duration.toInt())
                JSONObject()
                    .put("injected", true)
                    .put("gesture", "swipe")
                    .put("startX", startX)
                    .put("startY", startY)
                    .put("endX", endX)
                    .put("endY", endY)
                    .put("durationMs", duration)
            }
            args.size == 4 && args[0] == "long-press" -> {
                val x = coordinate(args[1], "long-press x")
                val y = coordinate(args[2], "long-press y")
                val duration = parseDurationMillis(args[3], "long-press duration")
                if (duration > Int.MAX_VALUE) throw TargetFsException("Long-press duration is too large")
                platform.swipe(x, y, x, y, duration.toInt())
                JSONObject()
                    .put("injected", true)
                    .put("gesture", "long-press")
                    .put("x", x)
                    .put("y", y)
                    .put("durationMs", duration)
            }
            args.size == 2 && args[0] == "key" -> {
                platform.pressKey(args[1])
                JSONObject().put("injected", true).put("gesture", "key").put("key", args[1].uppercase())
            }
            args.size == 2 && args[0] == "text" -> {
                platform.typeText(args[1])
                JSONObject().put("injected", true).put("gesture", "text").put("characters", args[1].length)
            }
            else -> return usage(INPUT_USAGE)
        }
        ensureCurrent(lease)
        return shellJson(output)
    }

    private fun requirePlatform() {
        if (!platform.supportsAutomation()) {
            throw TargetFsException("GSV OS platform automation is unavailable")
        }
    }

    private fun acquireLease(): AuthorityLease = authority.acquire() ?: throw TargetFsException(
        if (authority.state() == AuthorityState.PAUSED) "Wear Mode is paused" else "Wear Mode is not armed",
    )

    private fun ensureCurrent(lease: AuthorityLease) {
        if (!authority.isCurrent(lease)) throw TargetFsException("Wear Mode authority changed during input")
    }

    private fun coordinate(value: String, label: String): Int {
        val parsed = value.toIntOrNull() ?: throw TargetFsException("$label must be an integer")
        if (parsed < 0) throw TargetFsException("$label must not be negative")
        return parsed
    }

    private fun usage(value: String): TargetCommandResult = TargetCommandResult(
        stderr = "Usage: $value\n",
        exitCode = 2,
    )

    private companion object {
        const val INPUT_USAGE =
            "input tap X Y | swipe X1 Y1 X2 Y2 DURATION | long-press X Y DURATION | key NAME | text TEXT"
    }
}
