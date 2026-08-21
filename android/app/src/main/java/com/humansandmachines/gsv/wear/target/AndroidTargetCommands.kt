package com.humansandmachines.gsv.wear.target

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

object AndroidTargetCommands {
    fun create(
        @Suppress("UNUSED_PARAMETER") fileSystem: TargetFileSystem,
        additionalCommands: List<TargetCommand> = emptyList(),
    ): List<TargetCommand> {
        lateinit var catalog: List<TargetCommand>
        val base = listOf(
            TargetCommand(
                name = "help",
                description = "Show the Android target command catalog",
                usage = "help [command]",
                category = "discovery",
            ) { args, _ ->
                when {
                    args.isEmpty() -> ok(helpText(catalog))
                    args.size == 1 -> catalog.find { it.name == args.single() }
                        ?.let { ok("${it.usage}\n\n${it.description}\n") }
                        ?: fail("help: unknown command: ${args.single()}")
                    else -> usage("help [command]")
                }
            },
            TargetCommand(
                name = "commands",
                description = "List commands or emit their machine-readable catalog",
                usage = "commands [--json]",
                category = "discovery",
            ) { args, _ ->
                when (args) {
                    emptyList<String>() -> ok(helpText(catalog))
                    listOf("--json") -> ok(commandCatalog(catalog) + "\n")
                    listOf("--help"), listOf("-h") -> ok("Usage: commands [--json]\n")
                    else -> usage("commands [--json]")
                }
            },
            TargetCommand("pwd", "Print the virtual working directory", "pwd") { args, context ->
                if (args.isNotEmpty()) usage("pwd") else ok("${context.cwd}\n")
            },
            TargetCommand("ls", "List virtual files and directories", "ls [-l] [path ...]") { args, context ->
                listFiles(args, context)
            },
            TargetCommand("cat", "Print virtual text files or standard input", "cat [path ...]") { args, context ->
                if (args.isEmpty()) ok(context.stdin) else concatenate(args, context)
            },
            TargetCommand("echo", "Print arguments", "echo [-n] [text ...]") { args, _ ->
                val newline = args.firstOrNull() != "-n"
                val values = if (newline) args else args.drop(1)
                ok(values.joinToString(" ") + if (newline) "\n" else "")
            },
            TargetCommand("printf", "Print a bounded formatted string", "printf FORMAT [ARG ...]") { args, _ ->
                if (args.isEmpty()) usage("printf FORMAT [ARG ...]") else format(args.first(), args.drop(1))
            },
            TargetCommand("mkdir", "Create virtual directories", "mkdir [-p] PATH ...") { args, context ->
                if (args.any { it.startsWith('-') && it != "-p" }) {
                    return@TargetCommand usage("mkdir [-p] PATH ...")
                }
                val paths = args.filterNot { it == "-p" }
                if (paths.isEmpty()) return@TargetCommand usage("mkdir [-p] PATH ...")
                paths.forEach { context.fileSystem.mkdir(context.fileSystem.resolve(it, context.cwd)) }
                ok()
            },
            TargetCommand("touch", "Create empty files or update them", "touch PATH ...") { args, context ->
                if (args.isEmpty()) return@TargetCommand usage("touch PATH ...")
                args.forEach { context.fileSystem.touch(context.fileSystem.resolve(it, context.cwd)) }
                ok()
            },
            TargetCommand("rm", "Delete virtual files or directory trees", "rm [-rf] PATH ...") { args, context ->
                removeFiles(args, context)
            },
            TargetCommand("cp", "Copy one virtual file", "cp SOURCE DESTINATION") { args, context ->
                if (args.size != 2) return@TargetCommand usage("cp SOURCE DESTINATION")
                val copied = context.fileSystem.copy(
                    context.fileSystem.resolve(args[0], context.cwd),
                    context.fileSystem.resolve(args[1], context.cwd),
                )
                ok("${copied.path}\n")
            },
            TargetCommand("mv", "Move one writable virtual file", "mv SOURCE DESTINATION") { args, context ->
                if (args.size != 2) return@TargetCommand usage("mv SOURCE DESTINATION")
                val moved = context.fileSystem.move(
                    context.fileSystem.resolve(args[0], context.cwd),
                    context.fileSystem.resolve(args[1], context.cwd),
                )
                ok("${moved.path}\n")
            },
            TargetCommand("stat", "Describe virtual filesystem entries", "stat PATH ...") { args, context ->
                if (args.isEmpty()) return@TargetCommand usage("stat PATH ...")
                val output = StringBuilder()
                for (rawPath in args) {
                    val stat = context.fileSystem.stat(context.fileSystem.resolve(rawPath, context.cwd))
                    val entry = JSONObject()
                        .put("path", stat.path)
                        .put("type", if (stat.isDirectory) "directory" else "file")
                        .put("size", stat.size)
                        .apply { stat.contentType?.let { put("contentType", it) } }
                        .apply { if (stat.eventProducing) put("eventProducing", true) }
                        .toString() + "\n"
                    if (!output.appendCommandOutput(entry)) break
                }
                ok(output.toString())
            },
            TargetCommand("head", "Print the first lines of text", "head [-n COUNT] [path ...]") { args, context ->
                lineSlice(args, context, fromEnd = false)
            },
            TargetCommand("tail", "Print the last lines of text", "tail [-n COUNT] [path ...]") { args, context ->
                lineSlice(args, context, fromEnd = true)
            },
            TargetCommand("wc", "Count lines, words, and bytes", "wc [-lwc] [path ...]") { args, context ->
                countText(args, context)
            },
            TargetCommand("grep", "Search text or standard input", "grep [-in] PATTERN [path ...]") { args, context ->
                grep(args, context)
            },
            TargetCommand("find", "List virtual files below a path", "find [PATH] [-name GLOB]") { args, context ->
                find(args, context)
            },
            TargetCommand("date", "Print the current UTC time", "date", category = "runtime") { args, context ->
                if (args.isNotEmpty()) usage("date") else ok("${Instant.ofEpochMilli(context.nowMillis())}\n")
            },
            TargetCommand("whoami", "Print the virtual target user", "whoami", category = "runtime") { args, _ ->
                if (args.isNotEmpty()) usage("whoami") else ok("android\n")
            },
            TargetCommand("uname", "Identify the bounded Android target runtime", "uname [-a]", category = "runtime") { args, _ ->
                if (args.any { it != "-a" }) usage("uname [-a]") else ok("GSV Android virtual-target\n")
            },
            TargetCommand(
                name = "device",
                description = "Inspect this Android device",
                usage = "device status",
                category = "android",
            ) { args, context -> statusCommand(args, context, WearTargetRuntimeFiles.PROC_DEVICE, "device") },
            TargetCommand(
                name = "wear",
                description = "Inspect the current Wear Mode authority and sensor state",
                usage = "wear status",
                category = "wear",
            ) { args, context -> statusCommand(args, context, WearTargetRuntimeFiles.PROC_WEAR_STATUS, "wear") },
            TargetCommand(
                name = "camera",
                description = "Inspect the camera or capture one armed snapshot into virtual storage",
                usage = "camera status | camera snapshot [DESTINATION]",
                category = "wear",
            ) { args, context -> camera(args, context) },
        )
        val merged = linkedMapOf<String, TargetCommand>()
        (base + additionalCommands).forEach { merged[it.name] = it }
        catalog = merged.values.toList()
        return catalog
    }

    private suspend fun listFiles(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        val long = args.any { it == "-l" }
        val paths = args.filterNot { it == "-l" }.ifEmpty { listOf(context.cwd) }
        val output = StringBuilder()
        pathLoop@ for ((pathIndex, rawPath) in paths.withIndex()) {
            val path = context.fileSystem.resolve(rawPath, context.cwd)
            val stat = context.fileSystem.stat(path)
            if (paths.size > 1) output.append(path).append(":\n")
            if (stat.isFile) {
                output.append(if (long) longEntry(stat, TargetPath.basename(path)) else TargetPath.basename(path)).append('\n')
            } else {
                val listing = context.fileSystem.list(path)
                val entries = listing.directories.map { "$it/" } + listing.files
                for (entry in entries.sorted()) {
                    if (long) {
                        val child = context.fileSystem.stat(TargetPath.join(path, entry.removeSuffix("/")))
                        output.append(longEntry(child, entry))
                    } else {
                        output.append(entry)
                    }
                    output.append('\n')
                    if (output.isCommandOutputFull()) break@pathLoop
                }
            }
            if (pathIndex < paths.lastIndex) output.append('\n')
            if (output.isCommandOutputFull()) break
        }
        return ok(output.toString())
    }

    private suspend fun concatenate(paths: List<String>, context: TargetCommandContext): TargetCommandResult {
        val output = StringBuilder()
        for (path in paths) {
            val text = readShellText(context.fileSystem, context.fileSystem.resolve(path, context.cwd))
            if (!output.appendCommandOutput(text)) break
        }
        return ok(output.toString())
    }

    private suspend fun removeFiles(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        var force = false
        var recursive = false
        val paths = mutableListOf<String>()
        for (arg in args) {
            if (arg.startsWith('-') && arg != "-") {
                if (arg.drop(1).any { it !in "rf" }) return usage("rm [-rf] PATH ...")
                if ('f' in arg) force = true
                if ('r' in arg) recursive = true
            } else {
                paths += arg
            }
        }
        if (paths.isEmpty()) return usage("rm [-rf] PATH ...")
        for (path in paths) {
            try {
                val resolved = context.fileSystem.resolve(path, context.cwd)
                if (!recursive && context.fileSystem.stat(resolved).isDirectory) {
                    return fail("rm: cannot remove '$path': is a directory (use -r)")
                }
                context.fileSystem.delete(resolved)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (!force) throw error
            }
        }
        return ok()
    }

    private suspend fun lineSlice(
        args: List<String>,
        context: TargetCommandContext,
        fromEnd: Boolean,
    ): TargetCommandResult {
        var count = 10
        var index = 0
        if (args.getOrNull(0) == "-n") {
            count = args.getOrNull(1)?.toIntOrNull()?.takeIf { it >= 0 }
                ?: return usage("${if (fromEnd) "tail" else "head"} [-n COUNT] [path ...]")
            index = 2
        }
        val paths = args.drop(index)
        val sources = if (paths.isEmpty()) listOf(null) else paths.map { it }
        val output = StringBuilder()
        for (path in sources) {
            val text = if (path == null) context.stdin else readShellText(
                context.fileSystem,
                context.fileSystem.resolve(path, context.cwd),
            )
            val lines = text.lineSequence().toList()
            val selected = if (fromEnd) lines.takeLast(count) else lines.take(count)
            val selectedText = selected.joinToString("\n") + if (selected.isNotEmpty()) "\n" else ""
            if (!output.appendCommandOutput(selectedText)) break
        }
        return ok(output.toString())
    }

    private suspend fun countText(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        var showLines = false
        var showWords = false
        var showBytes = false
        var index = 0
        while (index < args.size && args[index].startsWith('-') && args[index] != "-") {
            val flags = args[index].drop(1)
            if (flags.isEmpty() || flags.any { it !in "lwc" }) return usage("wc [-lwc] [path ...]")
            showLines = showLines || 'l' in flags
            showWords = showWords || 'w' in flags
            showBytes = showBytes || 'c' in flags
            index += 1
        }
        if (!showLines && !showWords && !showBytes) {
            showLines = true
            showWords = true
            showBytes = true
        }
        val pathArgs = args.drop(index)
        val paths: List<String?> = if (pathArgs.isEmpty()) listOf(null) else pathArgs
        val output = StringBuilder()
        for (path in paths) {
            val text = if (path == null) context.stdin else readShellText(
                context.fileSystem,
                context.fileSystem.resolve(path, context.cwd),
            )
            val lines = if (text.isEmpty()) 0 else text.count { it == '\n' } + if (text.endsWith('\n')) 0 else 1
            val words = Regex("\\S+").findAll(text).count()
            val bytes = text.toByteArray(Charsets.UTF_8).size
            val counts = buildList {
                if (showLines) add(lines)
                if (showWords) add(words)
                if (showBytes) add(bytes)
            }
            output.append(counts.joinToString(" "))
            if (path != null) output.append(' ').append(path)
            output.append('\n')
            if (output.isCommandOutputFull()) break
        }
        return ok(output.toString())
    }

    private suspend fun grep(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        var ignoreCase = false
        var lineNumbers = false
        var index = 0
        while (index < args.size && args[index].startsWith('-') && args[index] != "-") {
            val flags = args[index].drop(1)
            if (flags.any { it !in "in" }) return usage("grep [-in] PATTERN [path ...]")
            ignoreCase = ignoreCase || 'i' in flags
            lineNumbers = lineNumbers || 'n' in flags
            index += 1
        }
        val pattern = args.getOrNull(index) ?: return usage("grep [-in] PATTERN [path ...]")
        val paths = args.drop(index + 1)
        val sources: List<String?> = if (paths.isEmpty()) listOf(null) else paths
        val output = StringBuilder()
        var matched = false
        for (path in sources) {
            val text = if (path == null) context.stdin else readShellText(
                context.fileSystem,
                context.fileSystem.resolve(path, context.cwd),
            )
            for ((lineIndex, line) in text.lineSequence().withIndex()) {
                if (line.contains(pattern, ignoreCase = ignoreCase)) {
                    matched = true
                    val match = buildString {
                        if (paths.size > 1 && path != null) append(path).append(':')
                        if (lineNumbers) append(lineIndex + 1).append(':')
                        append(line).append('\n')
                    }
                    if (!output.appendCommandOutput(match)) break
                }
            }
            if (output.isCommandOutputFull()) break
        }
        return TargetCommandResult(stdout = output.toString(), exitCode = if (matched) 0 else 1)
    }

    private suspend fun find(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        var path = context.cwd
        var glob: String? = null
        var index = 0
        if (args.getOrNull(0)?.startsWith('-') == false) {
            path = context.fileSystem.resolve(args[0], context.cwd)
            index = 1
        }
        if (index < args.size) {
            if (args.getOrNull(index) != "-name" || args.getOrNull(index + 1) == null || index + 2 != args.size) {
                return usage("find [PATH] [-name GLOB]")
            }
            glob = args[index + 1]
        }
        val output = StringBuilder()
        for (file in context.fileSystem.allFiles(path)) {
            if (glob != null && !globMatches(glob, TargetPath.basename(file))) continue
            if (!output.appendCommandOutput("$file\n")) break
        }
        return ok(output.toString())
    }

    private suspend fun statusCommand(
        args: List<String>,
        context: TargetCommandContext,
        path: String,
        command: String,
    ): TargetCommandResult = if (args == listOf("status")) {
        ok(readShellText(context.fileSystem, path))
    } else {
        usage("$command status")
    }

    private suspend fun camera(args: List<String>, context: TargetCommandContext): TargetCommandResult {
        return when (args.firstOrNull()) {
            "status" -> {
                if (args.size != 1) return usage("camera status")
                val status = JSONObject(readShellText(context.fileSystem, WearTargetRuntimeFiles.PROC_WEAR_STATUS))
                ok(
                    JSONObject()
                        .put("camera", status.optString("camera"))
                        .put(
                            "authorized",
                            status.optJSONObject("capabilities")
                                ?.optJSONObject("camera.snapshot")
                                ?.optBoolean("authorized", false) ?: false,
                        )
                        .put("path", WearTargetRuntimeFiles.CAMERA_SNAPSHOT)
                        .toString() + "\n",
                )
            }
            "snapshot" -> {
                if (args.size > 2) return usage("camera snapshot [DESTINATION]")
                val destination = context.fileSystem.resolve(
                    args.getOrNull(1) ?: "/tmp/camera/snapshot-${context.nowMillis()}.jpg",
                    context.cwd,
                )
                val captured = context.fileSystem.copy(WearTargetRuntimeFiles.CAMERA_SNAPSHOT, destination)
                ok(
                    JSONObject()
                        .put("path", captured.path)
                        .put("size", captured.size)
                        .put("contentType", captured.contentType)
                        .toString() + "\n",
                )
            }
            else -> usage("camera status | camera snapshot [DESTINATION]")
        }
    }

    private fun helpText(commands: List<TargetCommand>): String = buildString {
        append("GSV Android virtual shell\n\n")
        commands.groupBy(TargetCommand::category).forEach { (category, entries) ->
            append(category).append(":\n")
            entries.forEach { append("  ").append(it.name.padEnd(10)).append(it.description).append('\n') }
            append('\n')
        }
        append("This is a bounded virtual shell; it does not execute Android system binaries.\n")
        append("Run `help COMMAND` or `commands --json` for details.\n")
    }

    private fun commandCatalog(commands: List<TargetCommand>): String = JSONArray().apply {
        commands.forEach { command ->
            put(
                JSONObject()
                    .put("name", command.name)
                    .put("description", command.description)
                    .put("usage", command.usage)
                    .put("category", command.category),
            )
        }
    }.toString(2)

    private fun longEntry(stat: TargetStat, name: String): String = buildString {
        append(if (stat.isDirectory) 'd' else '-')
        append("r")
        append(if (stat.path.startsWith("/home/android") || stat.path.startsWith("/tmp")) "w" else "-")
        append("- ")
        append(stat.size.toString().padStart(10)).append(' ').append(name)
    }

    private fun format(template: String, args: List<String>): TargetCommandResult {
        val format = decodeEscapes(template)
        val output = StringBuilder()
        var argument = 0
        var index = 0
        while (index < format.length) {
            if (format[index] == '%' && index + 1 < format.length) {
                when (format[index + 1]) {
                    '%' -> {
                        output.append('%')
                        index += 2
                        continue
                    }
                    's' -> {
                        output.append(args.getOrNull(argument).orEmpty())
                        argument += 1
                        index += 2
                        continue
                    }
                    'd' -> {
                        val value = args.getOrNull(argument)?.toLongOrNull()
                            ?: return fail("printf: expected an integer for %d")
                        output.append(value)
                        argument += 1
                        index += 2
                        continue
                    }
                }
            }
            output.append(format[index])
            index += 1
        }
        return ok(output.toString())
    }

    private fun decodeEscapes(value: String): String = buildString {
        var index = 0
        while (index < value.length) {
            if (value[index] == '\\' && index + 1 < value.length) {
                append(
                    when (value[index + 1]) {
                        'n' -> '\n'
                        'r' -> '\r'
                        't' -> '\t'
                        '\\' -> '\\'
                        else -> value[index + 1]
                    },
                )
                index += 2
            } else {
                append(value[index])
                index += 1
            }
        }
    }

    private fun globMatches(pattern: String, value: String): Boolean {
        val regex = buildString {
            append('^')
            pattern.forEach { char ->
                when (char) {
                    '*' -> append(".*")
                    '?' -> append('.')
                    else -> append(Regex.escape(char.toString()))
                }
            }
            append('$')
        }
        return Regex(regex).matches(value)
    }

    private fun ok(stdout: String = ""): TargetCommandResult = TargetCommandResult(stdout = stdout)

    private fun fail(message: String): TargetCommandResult = TargetCommandResult(
        stderr = message.trimEnd() + "\n",
        exitCode = 1,
    )

    private fun usage(value: String): TargetCommandResult = fail("Usage: $value")

    private fun StringBuilder.appendCommandOutput(value: String): Boolean {
        val remaining = MAX_COMMAND_OUTPUT_CHARS + 1 - length
        if (remaining <= 0) return false
        append(value, 0, value.length.coerceAtMost(remaining))
        return value.length <= remaining
    }

    private fun StringBuilder.isCommandOutputFull(): Boolean = length > MAX_COMMAND_OUTPUT_CHARS

    private const val MAX_COMMAND_OUTPUT_CHARS = 1024 * 1024
}

suspend fun readShellText(fileSystem: TargetFileSystem, path: String): String {
    val stat = fileSystem.stat(path)
    if (!stat.isFile) throw TargetFsException("Is a directory: ${stat.path}")
    val contentType = stat.contentType ?: "application/octet-stream"
    if (!AndroidTargetFileSystem.isTextContentType(contentType)) {
        throw TargetFsException("Binary file: ${stat.path} ($contentType)")
    }
    if (stat.size > MAX_SHELL_TEXT_BYTES) throw TargetFsException("File exceeds the shell text limit: ${stat.path}")
    return fileSystem.open(stat.path).use { opened ->
        if (!AndroidTargetFileSystem.isTextContentType(opened.contentType)) {
            throw TargetFsException("Binary file: ${opened.path} (${opened.contentType})")
        }
        AndroidTargetFileSystem.decodeUtf8(opened.open().use { input -> readShellBytes(input) })
    }
}

private suspend fun readShellBytes(input: InputStream): ByteArray = withContext(Dispatchers.IO) {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
        currentCoroutineContext().ensureActive()
        val count = input.read(buffer)
        if (count < 0) break
        if (count == 0) continue
        total += count
        if (total > MAX_SHELL_TEXT_BYTES) throw TargetFsException("Shell text input exceeds $MAX_SHELL_TEXT_BYTES bytes")
        output.write(buffer, 0, count)
    }
    output.toByteArray()
}

private const val MAX_SHELL_TEXT_BYTES = 1024L * 1024
