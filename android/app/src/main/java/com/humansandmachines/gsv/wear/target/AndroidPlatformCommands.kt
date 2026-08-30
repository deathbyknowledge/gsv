package com.humansandmachines.gsv.wear.target

import com.humansandmachines.gsv.wear.actions.AndroidActions
import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.device.CurrentLocationRequest
import com.humansandmachines.gsv.wear.device.DeviceContextSource
import com.humansandmachines.gsv.wear.device.LocationProviderPreference
import com.humansandmachines.gsv.wear.notifications.NotificationAccess
import com.humansandmachines.gsv.wear.platform.GsvPlatformOperations
import org.json.JSONObject

class AndroidPlatformCommands(
    private val device: DeviceContextSource,
    private val actions: AndroidActions,
    private val notifications: NotificationAccess,
    private val authority: WearAuthority,
    private val platform: GsvPlatformOperations? = null,
) {
    fun commands(): List<TargetCommand> = listOf(
        TargetCommand(
            name = "device",
            description = "Inspect battery, network, thermal, storage, permission, and hardware context",
            usage = "device status | battery | network | thermal",
            category = "android",
            run = ::device,
        ),
        TargetCommand(
            name = "location",
            description = "Read a freshness-checked phone location",
            usage = LOCATION_USAGE,
            category = "android",
            run = ::location,
        ),
        TargetCommand(
            name = "apps",
            description = "List, inspect, or open launcher applications",
            usage = "apps list | foreground | open PACKAGE",
            category = "android",
            run = ::apps,
        ),
        TargetCommand(
            name = "intent",
            description = "Open a bounded Android deep link or browser URI",
            usage = "intent open URI [--package PACKAGE]",
            category = "android",
            run = ::intent,
        ),
        TargetCommand(
            name = "share",
            description = "Open Android sharing for text or a virtual target file",
            usage = "share text TEXT [--title TITLE] | file PATH [--type MIME]",
            category = "android",
            run = ::share,
        ),
        TargetCommand(
            name = "clipboard",
            description = "Read, write, or clear the Android clipboard",
            usage = "clipboard read | write TEXT [--sensitive] | clear",
            category = "android",
            run = ::clipboard,
        ),
        TargetCommand(
            name = "notifications",
            description = "Inspect and act on Android notifications",
            usage = "notifications status | list | read ID | dismiss ID | action ID INDEX | reply ID INDEX TEXT",
            category = "android",
            run = ::notifications,
        ),
        TargetCommand(
            name = "notify",
            description = "Show a user-visible Android notification",
            usage = "notify TITLE TEXT",
            category = "output",
            run = ::notify,
        ),
        TargetCommand(
            name = "speak",
            description = "Speak text through Android text-to-speech",
            usage = "speak TEXT [--language TAG] [--rate N] [--pitch N]",
            category = "output",
            run = ::speak,
        ),
        TargetCommand(
            name = "vibrate",
            description = "Run a bounded haptic vibration pattern",
            usage = "vibrate DURATION | vibrate --pattern DURATION,DURATION,...",
            category = "output",
            run = ::vibrate,
        ),
    )

    private suspend fun device(args: List<String>, context: TargetCommandContext): TargetCommandResult = when (args) {
        listOf("status") -> shellJson(device.status())
        listOf("battery") -> shellJson(device.battery())
        listOf("network") -> shellJson(device.network())
        listOf("thermal") -> shellJson(device.thermal())
        else -> usage("device status | battery | network | thermal")
    }

    private suspend fun location(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        if (args.firstOrNull() != "current") return usage(LOCATION_USAGE)
        var timeout = CurrentLocationRequest.DEFAULT_TIMEOUT_MILLIS
        var provider = LocationProviderPreference.BEST
        var maxAge = CurrentLocationRequest.DEFAULT_MAX_AGE_MILLIS
        var force = false
        var allowCached = false
        val seen = mutableSetOf<String>()
        var index = 1
        while (index < args.size) {
            val option = args[index]
            if (!seen.add(option)) return usage(LOCATION_USAGE)
            when (option) {
                "--timeout" -> {
                    val value = args.getOrNull(index + 1) ?: return usage(LOCATION_USAGE)
                    timeout = parseDurationMillis(value, "location timeout")
                    index += 2
                }
                "--provider" -> {
                    val value = args.getOrNull(index + 1) ?: return usage(LOCATION_USAGE)
                    provider = LocationProviderPreference.fromWireName(value) ?: return usage(LOCATION_USAGE)
                    index += 2
                }
                "--max-age" -> {
                    val value = args.getOrNull(index + 1) ?: return usage(LOCATION_USAGE)
                    maxAge = parseDurationMillis(value, "location maximum age")
                    index += 2
                }
                "--force" -> {
                    force = true
                    index += 1
                }
                "--allow-cached" -> {
                    allowCached = true
                    index += 1
                }
                else -> return usage(LOCATION_USAGE)
            }
        }
        if (force && allowCached) throw TargetFsException("--force cannot be combined with --allow-cached")
        val lease = authority.acquire() ?: throw TargetFsException(
            if (authority.state() == AuthorityState.PAUSED) "Wear Mode is paused" else "Wear Mode is not armed",
        )
        val location = device.currentLocation(
            CurrentLocationRequest(
                timeoutMillis = timeout,
                provider = provider,
                maxAgeMillis = maxAge,
                forceNewFix = force,
                allowCachedFallback = allowCached,
            ),
        )
        if (!authority.isCurrent(lease)) throw TargetFsException("Wear Mode authority changed during location request")
        return shellJson(location)
    }

    private suspend fun apps(args: List<String>, context: TargetCommandContext): TargetCommandResult = when {
        args == listOf("list") -> shellJson(actions.apps())
        args == listOf("foreground") -> {
            val service = requirePlatform()
            val lease = acquirePlatformLease()
            val activity = service.foregroundActivity()
            ensurePlatformLease(lease)
            shellJson(
                JSONObject()
                    .put("available", activity != null)
                    .apply {
                        activity?.let {
                            put("package", it.packageName)
                            put("activity", it.className)
                        }
                    },
            )
        }
        args.size == 2 && args[0] == "open" -> {
            val service = platform?.takeIf(GsvPlatformOperations::supportsAutomation)
            if (service == null) {
                shellJson(actions.openApp(args[1]))
            } else {
                val lease = acquirePlatformLease()
                service.launchApp(args[1])
                ensurePlatformLease(lease)
                shellJson(
                    JSONObject()
                        .put("package", args[1])
                        .put("launched", true)
                        .put("requiresUserTap", false),
                )
            }
        }
        else -> usage("apps list | foreground | open PACKAGE")
    }

    private fun requirePlatform(): GsvPlatformOperations =
        platform?.takeIf(GsvPlatformOperations::supportsAutomation)
            ?: throw TargetFsException("GSV OS platform automation is unavailable")

    private fun acquirePlatformLease() = authority.acquire() ?: throw TargetFsException(
        if (authority.state() == AuthorityState.PAUSED) "Wear Mode is paused" else "Wear Mode is not armed",
    )

    private fun ensurePlatformLease(lease: com.humansandmachines.gsv.wear.authority.AuthorityLease) {
        if (!authority.isCurrent(lease)) throw TargetFsException("Wear Mode authority changed during app control")
    }

    private suspend fun intent(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        if (args.size !in 2..4 || args[0] != "open") return usage("intent open URI [--package PACKAGE]")
        val packageName = when {
            args.size == 2 -> null
            args.size == 4 && args[2] == "--package" -> args[3]
            else -> return usage("intent open URI [--package PACKAGE]")
        }
        return shellJson(actions.openUri(args[1], packageName))
    }

    private suspend fun share(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        return when (args.firstOrNull()) {
            "text" -> {
                if (args.size !in 2..4) return usage("share text TEXT [--title TITLE]")
                val title = when {
                    args.size == 2 -> null
                    args.size == 4 && args[2] == "--title" -> args[3]
                    else -> return usage("share text TEXT [--title TITLE]")
                }
                shellJson(actions.shareText(args[1], title))
            }
            "file" -> {
                if (args.size !in 2..4) return usage("share file PATH [--type MIME]")
                val contentTypeOverride = when {
                    args.size == 2 -> null
                    args.size == 4 && args[2] == "--type" -> args[3]
                    else -> return usage("share file PATH [--type MIME]")
                }
                val path = context.fileSystem.resolve(args[1], context.cwd)
                context.fileSystem.open(path).use { opened ->
                    val contentType = contentTypeOverride ?: opened.contentType
                    if (!MIME_PATTERN.matches(contentType)) throw TargetFsException("Invalid share MIME type")
                    opened.open().use { input ->
                        shellJson(
                            actions.shareFile(
                                TargetPath.basename(path),
                                contentType,
                                input,
                                opened.length,
                            ),
                        )
                    }
                }
            }
            else -> usage("share text TEXT [--title TITLE] | file PATH [--type MIME]")
        }
    }

    private suspend fun clipboard(args: List<String>, context: TargetCommandContext): TargetCommandResult = when {
        args == listOf("read") -> shellJson(actions.clipboardRead())
        args == listOf("clear") -> shellJson(actions.clipboardClear())
        args.size in 2..3 && args[0] == "write" -> {
            val sensitive = args.getOrNull(2) == "--sensitive"
            if (args.size == 3 && !sensitive) {
                usage("clipboard write TEXT [--sensitive]")
            } else {
                shellJson(actions.clipboardWrite(args[1], sensitive))
            }
        }
        else -> usage("clipboard read | write TEXT [--sensitive] | clear")
    }

    private suspend fun notifications(
        args: List<String>,
        context: TargetCommandContext,
    ): TargetCommandResult = when {
        args == listOf("status") -> shellJson(notifications.status())
        args == listOf("list") -> shellJson(notifications.list())
        args.size == 2 && args[0] == "read" -> shellJson(notifications.read(args[1]))
        args.size == 2 && args[0] == "dismiss" -> shellJson(notifications.dismiss(args[1]))
        args.size == 3 && args[0] == "action" -> {
            val index = args[2].toIntOrNull() ?: return usage("notifications action ID INDEX")
            shellJson(notifications.action(args[1], index))
        }
        args.size == 4 && args[0] == "reply" -> {
            val index = args[2].toIntOrNull() ?: return usage("notifications reply ID INDEX TEXT")
            shellJson(notifications.reply(args[1], index, args[3]))
        }
        else -> usage(
            "notifications status | list | read ID | dismiss ID | action ID INDEX | reply ID INDEX TEXT",
        )
    }

    private suspend fun notify(args: List<String>, context: TargetCommandContext): TargetCommandResult =
        if (args.size == 2) shellJson(actions.showNotification(args[0], args[1])) else usage("notify TITLE TEXT")

    private suspend fun speak(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        if (args.isEmpty()) return usage("speak TEXT [--language TAG] [--rate N] [--pitch N]")
        val text = args[0]
        var language: String? = null
        var rate = 1.0f
        var pitch = 1.0f
        var index = 1
        while (index < args.size) {
            val value = args.getOrNull(index + 1)
                ?: return usage("speak TEXT [--language TAG] [--rate N] [--pitch N]")
            when (args[index]) {
                "--language" -> language = value
                "--rate" -> rate = value.toFloatOrNull()
                    ?: return usage("speak TEXT [--language TAG] [--rate N] [--pitch N]")
                "--pitch" -> pitch = value.toFloatOrNull()
                    ?: return usage("speak TEXT [--language TAG] [--rate N] [--pitch N]")
                else -> return usage("speak TEXT [--language TAG] [--rate N] [--pitch N]")
            }
            index += 2
        }
        return shellJson(actions.speak(text, language, rate, pitch))
    }

    private suspend fun vibrate(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        val pattern = when {
            args.size == 1 -> longArrayOf(parseDurationMillis(args[0], "vibration duration"))
            args.size == 2 && args[0] == "--pattern" -> args[1].split(',')
                .map { value -> parseDurationMillis(value, "vibration segment") }
                .toLongArray()
            else -> return usage("vibrate DURATION | vibrate --pattern DURATION,DURATION,...")
        }
        return shellJson(actions.vibrate(pattern))
    }

    private fun usage(value: String): TargetCommandResult = TargetCommandResult(
        stderr = "Usage: $value\n",
        exitCode = 2,
    )

    companion object {
        private const val LOCATION_USAGE =
            "location current [--provider best|gps|network] [--max-age DURATION] [--force] " +
                "[--allow-cached] [--timeout DURATION]"
        private val MIME_PATTERN = Regex("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+")
    }
}
