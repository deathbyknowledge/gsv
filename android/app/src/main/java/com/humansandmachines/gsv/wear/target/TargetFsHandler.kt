package com.humansandmachines.gsv.wear.target

import java.io.ByteArrayOutputStream
import java.io.InputStream
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

sealed interface TargetHandlerResponse {
    data class Data(val data: JSONObject) : TargetHandlerResponse

    data class Body(
        val data: JSONObject,
        val body: TargetReadHandle,
    ) : TargetHandlerResponse
}

interface TargetRequestBody : AutoCloseable {
    val length: Long?

    suspend fun open(): InputStream

    fun cancel(reason: String)
}

class TargetFsHandler(
    private val fileSystem: TargetFileSystem,
    private val targetId: String,
) {
    suspend fun handle(
        call: String,
        args: JSONObject,
        body: TargetRequestBody?,
    ): TargetHandlerResponse = when (call) {
        "fs.read" -> withoutBody(body) { read(args) }
        "fs.write" -> withoutBody(body) { dataResult { write(args) } }
        "fs.edit" -> withoutBody(body) { dataResult { edit(args) } }
        "fs.delete" -> withoutBody(body) { dataResult { delete(args) } }
        "fs.search" -> withoutBody(body) { dataResult { search(args) } }
        "fs.copy" -> withoutBody(body) { dataResult { copy(args) } }
        "fs.transfer.stat" -> withoutBody(body) { dataResult { transferStat(args) } }
        "fs.transfer.send" -> withoutBody(body) { transferSend(args) }
        "fs.transfer.receive" -> dataResult { transferReceive(args, body) }
        else -> throw TargetFsException("Unsupported filesystem syscall: $call")
    }

    private suspend fun read(args: JSONObject): TargetHandlerResponse {
        val path = requiredPath(args, "fs.read")
        return try {
            val stat = fileSystem.stat(path)
            if (stat.isDirectory) {
                val listing = fileSystem.list(path)
                TargetHandlerResponse.Data(
                    JSONObject()
                        .put("ok", true)
                        .put("path", stat.path)
                        .put("files", JSONArray(listing.files))
                        .put("directories", JSONArray(listing.directories)),
                )
            } else {
                readFile(args, stat)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            TargetHandlerResponse.Data(failure(error))
        }
    }

    private suspend fun readFile(args: JSONObject, stat: TargetStat): TargetHandlerResponse {
        val contentType = stat.contentType ?: "application/octet-stream"
        val image = contentType.startsWith("image/") && !AndroidTargetFileSystem.isTextContentType(contentType)
        if (image && args.optString("representation") == "resource") {
            if (stat.eventProducing) {
                return TargetHandlerResponse.Data(
                    JSONObject()
                        .put("ok", false)
                        .put("error", "Event-producing files must first be copied to /tmp or /home/android"),
                )
            }
            val revision = stat.revision ?: return TargetHandlerResponse.Data(
                JSONObject().put("ok", false).put("error", "File revision is unavailable: ${stat.path}"),
            )
            return TargetHandlerResponse.Data(
                JSONObject()
                    .put("ok", true)
                    .put("path", stat.path)
                    .put("kind", "image")
                    .put("contentType", contentType)
                    .put("size", stat.size)
                    .put(
                        "resource",
                        JSONObject()
                            .put("type", "file")
                            .put("target", targetId)
                            .put("path", stat.path)
                            .put("revision", revision)
                            .put("contentType", contentType)
                            .put("size", stat.size),
                    ),
            )
        }
        if (stat.eventProducing && (args.has("offset") || args.has("limit") || args.has("maxBytes"))) {
            return TargetHandlerResponse.Data(
                JSONObject().put("ok", false).put("error", "Event-producing files do not support text selection"),
            )
        }
        val opened = fileSystem.open(stat.path)
        if (opened.contentType.startsWith("image/") && !AndroidTargetFileSystem.isTextContentType(opened.contentType)) {
            return TargetHandlerResponse.Body(
                data = JSONObject()
                    .put("ok", true)
                    .put("path", opened.path)
                    .put("kind", "image")
                    .put("contentType", opened.contentType)
                    .put("size", opened.length),
                body = opened,
            )
        }
        if (!AndroidTargetFileSystem.isTextContentType(opened.contentType)) {
            opened.close()
            return TargetHandlerResponse.Data(
                JSONObject()
                    .put("ok", false)
                    .put("error", "Binary file (${opened.contentType}, ${formatSize(opened.length)})"),
            )
        }
        if (opened.length > AndroidTargetFileSystem.MAX_TEXT_READ_BYTES) {
            opened.close()
            return TargetHandlerResponse.Data(
                JSONObject()
                    .put("ok", false)
                    .put("error", "Text file exceeds Android read limit (${formatSize(opened.length)})"),
            )
        }

        return opened.use { handle ->
            val bytes = handle.open().use { readAll(it, handle.length) }
            val text = try {
                AndroidTargetFileSystem.decodeUtf8(bytes)
            } catch (_: Exception) {
                return@use TargetHandlerResponse.Data(
                    JSONObject()
                        .put("ok", false)
                        .put("error", "Binary file (${handle.contentType}, ${formatSize(handle.length)})"),
                )
            }
            val lines = splitLines(text)
            val offset = nonNegativeInteger(args, "offset") ?: 0
            val limit = nonNegativeInteger(args, "limit")
            val maxBytes = positiveInteger(args, "maxBytes")
            val selection = selectTextLines(lines, offset, limit, maxBytes)
            val selectedBytes = selection.content.toByteArray(Charsets.UTF_8)
            TargetHandlerResponse.Body(
                data = JSONObject()
                    .put("ok", true)
                    .put("path", handle.path)
                    .put("kind", "text")
                    .put("contentType", handle.contentType)
                    .put("lines", selection.lines)
                    .put("size", handle.length)
                    .apply {
                        if (selection.truncated) put("truncated", true)
                        selection.nextOffset?.let { put("nextOffset", it) }
                    },
                body = TargetReadHandle.fromBytes(handle.path, selectedBytes, handle.contentType),
            )
        }
    }

    private suspend fun write(args: JSONObject): JSONObject {
        val path = requiredPath(args, "fs.write")
        if (!args.has("content") || args.opt("content") !is String) {
            return JSONObject().put("ok", false).put("error", "fs.write requires string content")
        }
        val content = args.getString("content")
        val stat = fileSystem.writeText(path, content)
        return JSONObject().put("ok", true).put("path", stat.path).put("size", stat.size)
    }

    private suspend fun edit(args: JSONObject): JSONObject {
        val path = requiredPath(args, "fs.edit")
        if (args.opt("oldString") !is String || args.opt("newString") !is String) {
            return JSONObject().put("ok", false).put("error", "fs.edit requires oldString and newString")
        }
        val oldString = args.getString("oldString")
        val newString = args.getString("newString")
        if (oldString.isEmpty()) {
            return JSONObject().put("ok", false).put("error", "fs.edit oldString must not be empty")
        }
        val original = readText(path)
        val occurrences = countOccurrences(original, oldString)
        if (occurrences == 0) {
            return JSONObject().put("ok", false).put("error", "oldString not found in ${fileSystem.resolve(path)}")
        }
        val replaceAll = args.optBoolean("replaceAll", false)
        if (!replaceAll && occurrences > 1) {
            return JSONObject()
                .put("ok", false)
                .put("error", "oldString found $occurrences times. Use replaceAll or provide more context.")
        }
        val updated = if (replaceAll) {
            original.replace(oldString, newString)
        } else {
            original.replaceFirst(oldString, newString)
        }
        val stat = fileSystem.writeText(path, updated)
        return JSONObject()
            .put("ok", true)
            .put("path", stat.path)
            .put("replacements", if (replaceAll) occurrences else 1)
    }

    private suspend fun delete(args: JSONObject): JSONObject {
        val path = requiredPath(args, "fs.delete")
        fileSystem.delete(path)
        return JSONObject().put("ok", true).put("path", fileSystem.resolve(path))
    }

    private suspend fun search(args: JSONObject): JSONObject {
        val query = (args.opt("query") as? String)?.trim().orEmpty()
        if (query.isEmpty()) return JSONObject().put("ok", false).put("error", "fs.search requires query")
        val path = (args.opt("path") as? String)?.takeIf(String::isNotBlank) ?: TargetPath.HOME
        val include = (args.opt("include") as? String)?.takeIf(String::isNotBlank)
        val result = fileSystem.search(path, query, include)
        return JSONObject()
            .put("ok", true)
            .put(
                "matches",
                JSONArray().apply {
                    result.matches.forEach { match ->
                        put(
                            JSONObject()
                                .put("path", match.path)
                                .put("line", match.line)
                                .put("content", match.content),
                        )
                    }
                },
            )
            .put("count", result.matches.size)
            .apply { if (result.truncated) put("truncated", true) }
    }

    private suspend fun copy(args: JSONObject): JSONObject {
        val source = requiredEndpoint(args.optJSONObject("source"), "source")
        val destination = requiredEndpoint(args.optJSONObject("destination"), "destination")
        val copied = fileSystem.copy(source.path, destination.path)
        return JSONObject()
            .put("ok", true)
            .put("source", JSONObject().put("target", source.target).put("path", fileSystem.resolve(source.path)))
            .put(
                "destination",
                JSONObject().put("target", destination.target).put("path", copied.path),
            )
            .put("size", copied.size)
            .apply { copied.contentType?.let { put("contentType", it) } }
    }

    private suspend fun transferStat(args: JSONObject): JSONObject {
        val path = requiredPath(args, "fs.transfer.stat")
        val stat = fileSystem.stat(path)
        if (stat.eventProducing) {
            return JSONObject()
                .put("ok", false)
                .put("error", "Event-producing files must first be copied to /tmp or /home/android")
        }
        return JSONObject()
            .put("ok", true)
            .put("path", stat.path)
            .put("size", stat.size)
            .put("isFile", stat.isFile)
            .put("isDirectory", stat.isDirectory)
            .apply { stat.contentType?.let { put("contentType", it) } }
            .apply { stat.revision?.let { put("revision", it) } }
    }

    private suspend fun transferSend(args: JSONObject): TargetHandlerResponse {
        val path = requiredPath(args, "fs.transfer.send")
        return try {
            val stat = fileSystem.stat(path)
            if (!stat.isFile || stat.eventProducing) {
                return TargetHandlerResponse.Data(
                    JSONObject()
                        .put("ok", false)
                        .put("error", "Only ordinary files can be transferred"),
                )
            }
            val opened = fileSystem.open(path)
            val revision = opened.revision ?: stat.revision
            val expectedRevision = (args.opt("revision") as? String)?.takeIf(String::isNotBlank)
            if (revision == null || expectedRevision != null && expectedRevision != revision) {
                opened.close()
                return TargetHandlerResponse.Data(
                    JSONObject()
                        .put("ok", false)
                        .put("error", "Source revision is no longer available: ${stat.path}"),
                )
            }
            TargetHandlerResponse.Body(
                data = JSONObject()
                    .put("ok", true)
                    .put("path", opened.path)
                    .put("size", opened.length)
                    .put("contentType", opened.contentType)
                    .put("revision", revision),
                body = opened,
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            TargetHandlerResponse.Data(failure(error))
        }
    }

    private suspend fun transferReceive(args: JSONObject, body: TargetRequestBody?): JSONObject {
        val path = requiredPath(args, "fs.transfer.receive")
        if (body == null) {
            return JSONObject().put("ok", false).put("error", "fs.transfer.receive requires a request body")
        }
        val length = body.length
        if (length == null) {
            body.cancel("fs.transfer.receive requires a request body length")
            return JSONObject()
                .put("ok", false)
                .put("error", "fs.transfer.receive requires a request body length")
        }
        val contentType = (args.opt("contentType") as? String)?.takeIf(String::isNotBlank)
        val stat = body.open().use { input -> fileSystem.write(path, input, length, contentType) }
        return JSONObject()
            .put("ok", true)
            .put("path", stat.path)
            .put("bytesWritten", stat.size)
            .apply { stat.contentType?.let { put("contentType", it) } }
    }

    private suspend fun readText(path: String): String {
        val stat = fileSystem.stat(path)
        if (!stat.isFile) throw TargetFsException("Is a directory: ${stat.path}")
        if (!AndroidTargetFileSystem.isTextContentType(stat.contentType ?: "application/octet-stream")) {
            throw TargetFsException("Binary file: ${stat.path}")
        }
        if (stat.size > AndroidTargetFileSystem.MAX_TEXT_READ_BYTES) {
            throw TargetFsException("Text file exceeds Android read limit: ${stat.path}")
        }
        return fileSystem.open(stat.path).use { opened ->
            AndroidTargetFileSystem.decodeUtf8(opened.open().use { readAll(it, opened.length) })
        }
    }

    private suspend fun withoutBody(
        body: TargetRequestBody?,
        block: suspend () -> TargetHandlerResponse,
    ): TargetHandlerResponse {
        if (body == null) return block()
        body.cancel("Request body is unsupported")
        return TargetHandlerResponse.Data(JSONObject().put("ok", false).put("error", "Request body is unsupported"))
    }

    private suspend fun dataResult(block: suspend () -> JSONObject): TargetHandlerResponse = try {
        TargetHandlerResponse.Data(block())
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        TargetHandlerResponse.Data(failure(error))
    }

    private fun requiredPath(args: JSONObject, call: String): String {
        val path = (args.opt("path") as? String)?.trim().orEmpty()
        if (path.isEmpty()) throw TargetFsException("$call requires path")
        return path
    }

    private data class Endpoint(val target: String, val path: String)

    private fun requiredEndpoint(value: JSONObject?, label: String): Endpoint {
        val path = (value?.opt("path") as? String)?.trim().orEmpty()
        if (path.isEmpty()) throw TargetFsException("fs.copy requires $label.path")
        val target = (value?.opt("target") as? String)?.trim().orEmpty()
        return Endpoint(
            target = target.ifEmpty { "local" },
            path = path,
        )
    }

    private fun failure(error: Exception): JSONObject = JSONObject()
        .put("ok", false)
        .put("error", error.message ?: "Android target filesystem failed")

    private fun nonNegativeInteger(args: JSONObject, key: String): Int? {
        val value = args.opt(key)
        return when (value) {
            is Int -> value.takeIf { it >= 0 }
            is Long -> value.takeIf { it in 0..Int.MAX_VALUE }?.toInt()
            else -> null
        }
    }

    private fun positiveInteger(args: JSONObject, key: String): Int? {
        if (!args.has(key)) return null
        return when (val value = args.opt(key)) {
            is Int -> value.takeIf { it > 0 }
            is Long -> value.takeIf { it in 1..Int.MAX_VALUE }?.toInt()
            else -> null
        } ?: throw TargetFsException("fs.read $key must be a positive integer")
    }

    private data class TextSelection(
        val content: String,
        val lines: Int,
        val truncated: Boolean,
        val nextOffset: Int?,
    )

    private fun selectTextLines(
        allLines: List<String>,
        offset: Int,
        limit: Int?,
        maxBytes: Int?,
    ): TextSelection {
        val start = offset.coerceAtMost(allLines.size)
        val end = if (limit == null) allLines.size else (start.toLong() + limit).coerceAtMost(allLines.size.toLong()).toInt()
        val requested = allLines.subList(start, end)
        val byteLimit = maxBytes ?: Int.MAX_VALUE
        val selected = mutableListOf<String>()
        var usedBytes = 0L
        var partial = false

        for (line in requested) {
            val lineBytes = line.toByteArray(Charsets.UTF_8)
            val separatorBytes = if (selected.isEmpty()) 0 else 1
            if (usedBytes + separatorBytes + lineBytes.size <= byteLimit) {
                selected += line
                usedBytes += separatorBytes + lineBytes.size
                continue
            }
            if (selected.isEmpty()) {
                selected += utf8Prefix(lineBytes, byteLimit)
                partial = true
            }
            break
        }

        val lines = selected.size
        val truncated = partial || lines < requested.size || end < allLines.size
        val nextOffset = if (!partial && truncated && lines > 0) start + lines else null
        return TextSelection(selected.joinToString("\n"), lines, truncated, nextOffset)
    }

    private fun utf8Prefix(bytes: ByteArray, maximum: Int): String {
        var end = maximum.coerceAtMost(bytes.size)
        while (end > 0) {
            try {
                return AndroidTargetFileSystem.decodeUtf8(bytes.copyOf(end))
            } catch (_: Exception) {
                end -= 1
            }
        }
        return ""
    }

    private suspend fun readAll(input: InputStream, expectedSize: Long): ByteArray = withContext(Dispatchers.IO) {
        if (expectedSize > AndroidTargetFileSystem.MAX_TARGET_FILE_BYTES) {
            throw TargetFsException("File exceeds Android target read limit")
        }
        val output = ByteArrayOutputStream(expectedSize.coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
        val buffer = ByteArray(BUFFER_BYTES)
        var total = 0L
        while (true) {
            currentCoroutineContext().ensureActive()
            val count = input.read(buffer)
            if (count < 0) break
            if (count == 0) continue
            total += count
            if (total > AndroidTargetFileSystem.MAX_TARGET_FILE_BYTES) {
                throw TargetFsException("File exceeds Android target read limit")
            }
            output.write(buffer, 0, count)
        }
        output.toByteArray()
    }

    private fun countOccurrences(value: String, needle: String): Int {
        var count = 0
        var offset = 0
        while (true) {
            val index = value.indexOf(needle, offset)
            if (index < 0) return count
            count += 1
            offset = index + needle.length
        }
    }

    private fun splitLines(value: String): List<String> {
        if (value.isEmpty()) return listOf("")
        return value.split('\n')
    }

    private fun formatSize(size: Long): String = when {
        size < 1024 -> "$size B"
        size < 1024 * 1024 -> "%.1f KiB".format(size / 1024.0)
        else -> "%.1f MiB".format(size / 1024.0 / 1024.0)
    }

    companion object {
        private const val BUFFER_BYTES = 64 * 1024
    }
}
