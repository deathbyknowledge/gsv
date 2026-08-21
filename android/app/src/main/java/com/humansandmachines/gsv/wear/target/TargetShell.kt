package com.humansandmachines.gsv.wear.target

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

data class TargetCommandResult(
    val stdout: String = "",
    val stderr: String = "",
    val exitCode: Int = 0,
)

data class TargetCommandContext(
    val fileSystem: TargetFileSystem,
    val cwd: String,
    val stdin: String,
    val nowMillis: () -> Long,
)

data class TargetCommand(
    val name: String,
    val description: String,
    val usage: String,
    val category: String = "filesystem",
    val run: suspend (args: List<String>, context: TargetCommandContext) -> TargetCommandResult,
)

class TargetShell(
    private val fileSystem: TargetFileSystem,
    commands: List<TargetCommand> = AndroidTargetCommands.create(fileSystem),
    private val nowMillis: () -> Long = System::currentTimeMillis,
) {
    private val commands = commands.associateBy(TargetCommand::name)
    private val mutex = Mutex()

    suspend fun execute(args: JSONObject): JSONObject = mutex.withLock {
        val input = args.opt("input") as? String ?: return@withLock failed("shell.exec requires input")
        if (input.isBlank()) return@withLock failed("shell.exec requires input")
        if (input.length > MAX_INPUT_CHARS) return@withLock failed("Shell input exceeds $MAX_INPUT_CHARS characters")
        if ((args.opt("sessionId") as? String).orEmpty().isNotBlank()) {
            return@withLock failed("Android shell sessions are not supported yet")
        }
        if (args.opt("background") == true) {
            return@withLock failed("Android background shell sessions are not supported yet")
        }

        val cwd = try {
            fileSystem.resolve((args.opt("cwd") as? String)?.takeIf(String::isNotBlank) ?: TargetPath.HOME)
        } catch (error: Exception) {
            return@withLock failed(error.message ?: "Invalid shell working directory")
        }
        val cwdStat = try {
            fileSystem.stat(cwd)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            return@withLock failed("No such working directory: $cwd")
        }
        if (!cwdStat.isDirectory) return@withLock failed("Not a directory: $cwd")

        val requestedTimeout = when (val value = args.opt("timeout")) {
            null -> DEFAULT_TIMEOUT_MS
            is Int -> value.toLong()
            is Long -> value
            else -> return@withLock failed("timeout must be an integer")
        }
        val timeoutMs = when (val requested = requestedTimeout) {
            in 1..MAX_TIMEOUT_MS -> requested
            else -> return@withLock failed("timeout must be between 1 and $MAX_TIMEOUT_MS milliseconds")
        }

        try {
            withTimeout(timeoutMs) {
                executeProgram(TargetShellParser.parse(input), cwd)
            }
        } catch (_: TimeoutCancellationException) {
            failed("Android shell execution timed out after $timeoutMs milliseconds")
        } catch (_: CancellationException) {
            throw CancellationException("Android shell execution cancelled")
        } catch (error: Exception) {
            failed(error.message ?: "Android shell execution failed")
        }
    }

    private suspend fun executeProgram(program: ShellProgram, cwd: String): JSONObject {
        val stdout = StringBuilder()
        val stderr = StringBuilder()
        var exitCode = 0

        for (pipeline in program.pipelines) {
            val result = executePipeline(pipeline, cwd)
            stdout.append(result.stdout)
            stderr.append(result.stderr)
            exitCode = result.exitCode
            if (stdout.length + stderr.length > MAX_OUTPUT_CHARS) break
        }

        val combined = stdout.append(stderr).toString()
        val truncated = combined.length > MAX_OUTPUT_CHARS
        val output = if (truncated) combined.take(MAX_OUTPUT_CHARS) else combined
        return if (exitCode == 0) {
            JSONObject()
                .put("status", "completed")
                .put("output", output)
                .put("exitCode", 0)
                .apply { if (truncated) put("truncated", true) }
        } else {
            JSONObject()
                .put("status", "failed")
                .put("output", output)
                .put(
                    "error",
                    stderr.toString().take(MAX_OUTPUT_CHARS).takeIf(String::isNotBlank)
                        ?: "Command exited $exitCode",
                )
                .put("exitCode", exitCode)
                .apply { if (truncated) put("truncated", true) }
        }
    }

    private suspend fun executePipeline(pipeline: ShellPipeline, cwd: String): TargetCommandResult {
        var stdin = ""
        val stderr = StringBuilder()
        var exitCode = 0

        pipeline.commands.forEachIndexed { index, invocation ->
            if (invocation.inputPath != null) {
                stdin = readShellText(fileSystem, fileSystem.resolve(invocation.inputPath, cwd))
            }
            val command = commands[invocation.words.first()]
            val result = if (command == null) {
                TargetCommandResult(
                    stderr = "${invocation.words.first()}: command not found\n",
                    exitCode = 127,
                )
            } else {
                try {
                    command.run(
                        invocation.words.drop(1),
                        TargetCommandContext(fileSystem, cwd, stdin, nowMillis),
                    )
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    TargetCommandResult(
                        stderr = "${command.name}: ${error.message ?: "command failed"}\n",
                        exitCode = 1,
                    )
                }
            }
            stderr.append(result.stderr)
            exitCode = result.exitCode
            stdin = result.stdout

            if (
                stdin.length > MAX_PIPE_CHARS &&
                (index < pipeline.commands.lastIndex || invocation.outputPath != null)
            ) {
                return TargetCommandResult(
                    stderr = stderr.append("command output exceeds $MAX_PIPE_CHARS characters\n").toString(),
                    exitCode = 1,
                )
            }

            if (invocation.outputPath != null) {
                val outputPath = fileSystem.resolve(invocation.outputPath, cwd)
                val content = if (invocation.appendOutput) {
                    val exists = try {
                        fileSystem.stat(outputPath)
                        true
                    } catch (error: CancellationException) {
                        throw error
                    } catch (_: Exception) {
                        false
                    }
                    (if (exists) readShellText(fileSystem, outputPath) else "") + result.stdout
                } else {
                    result.stdout
                }
                fileSystem.writeText(outputPath, content)
                stdin = ""
            }
        }
        return TargetCommandResult(stdout = stdin, stderr = stderr.toString(), exitCode = exitCode)
    }

    private fun failed(message: String): JSONObject = JSONObject()
        .put("status", "failed")
        .put("output", "")
        .put("error", message)

    companion object {
        private const val DEFAULT_TIMEOUT_MS = 130_000L
        private const val MAX_TIMEOUT_MS = 180_000L
        private const val MAX_INPUT_CHARS = 32 * 1024
        private const val MAX_PIPE_CHARS = 1024 * 1024
        private const val MAX_OUTPUT_CHARS = 1024 * 1024
    }
}

private data class ShellProgram(val pipelines: List<ShellPipeline>)

private data class ShellPipeline(val commands: List<ShellInvocation>)

private data class ShellInvocation(
    val words: List<String>,
    val inputPath: String?,
    val outputPath: String?,
    val appendOutput: Boolean,
)

private enum class ShellTokenType {
    WORD,
    PIPE,
    SEQUENCE,
    INPUT,
    OUTPUT,
    APPEND,
}

private data class ShellToken(val type: ShellTokenType, val value: String = "")

private object TargetShellParser {
    fun parse(input: String): ShellProgram {
        val tokens = tokenize(input)
        if (tokens.isEmpty()) throw TargetFsException("shell.exec requires input")
        val pipelines = mutableListOf<ShellPipeline>()
        var commands = mutableListOf<ShellInvocation>()
        var words = mutableListOf<String>()
        var inputPath: String? = null
        var outputPath: String? = null
        var appendOutput = false
        var index = 0

        fun finishCommand() {
            if (words.isEmpty()) throw TargetFsException("Missing command")
            if (words.size > MAX_WORDS_PER_COMMAND) {
                throw TargetFsException("Command exceeds $MAX_WORDS_PER_COMMAND words")
            }
            commands += ShellInvocation(words.toList(), inputPath, outputPath, appendOutput)
            words = mutableListOf()
            inputPath = null
            outputPath = null
            appendOutput = false
        }

        fun finishPipeline() {
            finishCommand()
            if (commands.size > MAX_PIPELINE_COMMANDS) {
                throw TargetFsException("Pipeline exceeds $MAX_PIPELINE_COMMANDS commands")
            }
            pipelines += ShellPipeline(commands.toList())
            commands = mutableListOf()
        }

        while (index < tokens.size) {
            val token = tokens[index]
            when (token.type) {
                ShellTokenType.WORD -> words += token.value
                ShellTokenType.INPUT, ShellTokenType.OUTPUT, ShellTokenType.APPEND -> {
                    val path = tokens.getOrNull(index + 1)
                    if (path?.type != ShellTokenType.WORD) throw TargetFsException("Redirection requires a path")
                    when (token.type) {
                        ShellTokenType.INPUT -> {
                            if (inputPath != null) throw TargetFsException("Duplicate input redirection")
                            inputPath = path.value
                        }
                        ShellTokenType.OUTPUT, ShellTokenType.APPEND -> {
                            if (outputPath != null) throw TargetFsException("Duplicate output redirection")
                            outputPath = path.value
                            appendOutput = token.type == ShellTokenType.APPEND
                        }
                        else -> Unit
                    }
                    index += 1
                }
                ShellTokenType.PIPE -> finishCommand()
                ShellTokenType.SEQUENCE -> finishPipeline()
            }
            index += 1
        }
        finishPipeline()
        if (pipelines.size > MAX_PIPELINES) throw TargetFsException("Shell input exceeds $MAX_PIPELINES statements")
        return ShellProgram(pipelines)
    }

    private fun tokenize(input: String): List<ShellToken> {
        val tokens = mutableListOf<ShellToken>()
        val word = StringBuilder()
        var wordStarted = false
        var state = QuoteState.UNQUOTED
        var index = 0

        fun finishWord() {
            if (!wordStarted) return
            tokens += ShellToken(ShellTokenType.WORD, word.toString())
            word.setLength(0)
            wordStarted = false
        }

        while (index < input.length) {
            val char = input[index]
            when (state) {
                QuoteState.SINGLE -> when (char) {
                    '\'' -> state = QuoteState.UNQUOTED
                    else -> word.append(char)
                }
                QuoteState.DOUBLE -> when (char) {
                    '"' -> state = QuoteState.UNQUOTED
                    '\\' -> {
                        index += 1
                        if (index >= input.length) throw TargetFsException("Trailing escape")
                        word.append(input[index])
                    }
                    else -> word.append(char)
                }
                QuoteState.UNQUOTED -> when {
                    char == '\'' -> {
                        state = QuoteState.SINGLE
                        wordStarted = true
                    }
                    char == '"' -> {
                        state = QuoteState.DOUBLE
                        wordStarted = true
                    }
                    char == '\\' -> {
                        wordStarted = true
                        index += 1
                        if (index >= input.length) throw TargetFsException("Trailing escape")
                        word.append(input[index])
                    }
                    char == '#' && !wordStarted -> {
                        while (index < input.length && input[index] != '\n') index += 1
                        continue
                    }
                    char == ' ' || char == '\t' || char == '\r' -> finishWord()
                    char == '\n' || char == ';' -> {
                        finishWord()
                        if (tokens.lastOrNull()?.type != ShellTokenType.SEQUENCE) {
                            tokens += ShellToken(ShellTokenType.SEQUENCE)
                        }
                    }
                    char == '|' -> {
                        finishWord()
                        tokens += ShellToken(ShellTokenType.PIPE)
                    }
                    char == '<' -> {
                        finishWord()
                        tokens += ShellToken(ShellTokenType.INPUT)
                    }
                    char == '>' -> {
                        finishWord()
                        if (input.getOrNull(index + 1) == '>') {
                            tokens += ShellToken(ShellTokenType.APPEND)
                            index += 1
                        } else {
                            tokens += ShellToken(ShellTokenType.OUTPUT)
                        }
                    }
                    else -> {
                        wordStarted = true
                        word.append(char)
                    }
                }
            }
            index += 1
        }
        if (state != QuoteState.UNQUOTED) throw TargetFsException("Unterminated quote")
        finishWord()
        while (tokens.lastOrNull()?.type == ShellTokenType.SEQUENCE) tokens.removeAt(tokens.lastIndex)
        return tokens
    }

    private enum class QuoteState {
        UNQUOTED,
        SINGLE,
        DOUBLE,
    }

    private const val MAX_PIPELINE_COMMANDS = 32
    private const val MAX_PIPELINES = 64
    private const val MAX_WORDS_PER_COMMAND = 128
}
