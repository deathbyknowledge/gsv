package com.humansandmachines.gsv.wear.target

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

class AndroidTargetFileSystem(
    persistentRoot: File,
    temporaryRoot: File,
    private val runtime: TargetRuntimeFiles,
    private val persistentByteLimit: Long = MAX_PERSISTENT_BYTES,
    private val temporaryByteLimit: Long = MAX_TEMPORARY_BYTES,
    private val entryLimit: Int = MAX_ENTRIES_PER_MOUNT,
) : TargetFileSystem {
    private val persistentRoot = persistentRoot.canonicalFile
    private val temporaryRoot = temporaryRoot.canonicalFile
    private val mimeOverrides = ConcurrentHashMap<String, String>()
    private val quotaMutex = Mutex()

    init {
        require(persistentByteLimit > 0) { "Persistent byte limit must be positive" }
        require(temporaryByteLimit > 0) { "Temporary byte limit must be positive" }
        require(entryLimit > 0) { "Entry limit must be positive" }
        check(this.persistentRoot.mkdirs() || this.persistentRoot.isDirectory) {
            "Unable to create Android target home"
        }
        check(this.temporaryRoot.mkdirs() || this.temporaryRoot.isDirectory) {
            "Unable to create Android target tmp"
        }
    }

    fun clearTemporary() {
        temporaryRoot.listFiles()?.forEach(File::deleteRecursively)
        mimeOverrides.keys.removeAll { it == TMP || it.startsWith("$TMP/") }
    }

    override fun resolve(path: String, cwd: String): String = TargetPath.normalize(path, cwd)

    override suspend fun stat(path: String): TargetStat {
        val normalized = resolve(path)
        runtime.stat(normalized)?.let { return it }
        if (normalized in virtualDirectories()) {
            return TargetStat(normalized, isFile = false, isDirectory = true, size = 0)
        }

        val physical = physicalFile(normalized) ?: throw TargetFsException("No such file or directory: $normalized")
        return withContext(Dispatchers.IO) {
            when {
                physical.isDirectory -> TargetStat(normalized, isFile = false, isDirectory = true, size = 0)
                physical.isFile -> TargetStat(
                    path = normalized,
                    isFile = true,
                    isDirectory = false,
                    size = physical.length(),
                    contentType = mimeOverrides[normalized] ?: inferContentType(normalized, physical),
                )
                else -> throw TargetFsException("No such file or directory: $normalized")
            }
        }
    }

    override suspend fun list(path: String): TargetListing {
        val normalized = resolve(path)
        val pathStat = stat(normalized)
        if (!pathStat.isDirectory) throw TargetFsException("Not a directory: $normalized")

        val files = sortedSetOf<String>()
        val directories = sortedSetOf<String>()
        for (directory in virtualDirectories()) {
            if (directory != normalized && TargetPath.dirname(directory) == normalized) {
                directories += TargetPath.basename(directory)
            }
        }
        for (file in runtime.files) {
            if (TargetPath.dirname(file) == normalized) files += TargetPath.basename(file)
        }

        physicalFile(normalized)?.let { physical ->
            withContext(Dispatchers.IO) {
                physical.listFiles()?.forEach { child ->
                    if (child.isDirectory) directories += child.name else files += child.name
                }
            }
        }
        return TargetListing(files.toList(), directories.toList())
    }

    override suspend fun open(path: String): TargetReadHandle {
        val normalized = resolve(path)
        runtime.open(normalized)?.let { return it }
        val physical = physicalFile(normalized) ?: throw TargetFsException("No such file: $normalized")
        return withContext(Dispatchers.IO) {
            if (physical.isDirectory) throw TargetFsException("Is a directory: $normalized")
            if (!physical.isFile) throw TargetFsException("No such file: $normalized")
            TargetReadHandle.fromFile(
                path = normalized,
                file = physical,
                contentType = mimeOverrides[normalized] ?: inferContentType(normalized, physical),
            )
        }
    }

    override suspend fun write(
        path: String,
        input: InputStream,
        expectedSize: Long,
        contentType: String?,
    ): TargetStat {
        val normalized = resolve(path)
        requireWritableFile(normalized)
        val normalizedContentType = normalizeContentType(contentType)
        require(expectedSize in 0..MAX_TARGET_FILE_BYTES) {
            "File size must be between 0 and $MAX_TARGET_FILE_BYTES bytes"
        }
        mkdir(TargetPath.dirname(normalized))
        val destination = physicalFile(normalized)
            ?: throw TargetFsException("Path is outside writable Android target storage: $normalized")

        return withContext(Dispatchers.IO) {
            if (destination.isDirectory) throw TargetFsException("Is a directory: $normalized")

            val temporary = File.createTempFile(".gsv-write-", ".tmp", destination.parentFile)
            try {
                var written = 0L
                temporary.outputStream().use { output ->
                    val buffer = ByteArray(COPY_BUFFER_BYTES)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val count = input.read(buffer)
                        if (count < 0) break
                        if (count == 0) continue
                        written += count
                        if (written > expectedSize || written > MAX_TARGET_FILE_BYTES) {
                            throw TargetFsException(
                                "Transfer size mismatch: expected $expectedSize bytes, received more than $written",
                            )
                        }
                        output.write(buffer, 0, count)
                    }
                    output.flush()
                }
                if (written != expectedSize) {
                    throw TargetFsException(
                        "Transfer size mismatch: expected $expectedSize bytes, received $written",
                    )
                }
                quotaMutex.withLock {
                    validateWriteQuota(normalized, destination, temporary, written)
                    replaceFile(temporary, destination)
                    if (normalizedContentType != null) {
                        mimeOverrides[normalized] = normalizedContentType
                    } else {
                        mimeOverrides.remove(normalized)
                    }
                }
                TargetStat(
                    path = normalized,
                    isFile = true,
                    isDirectory = false,
                    size = written,
                    contentType = normalizedContentType
                        ?: inferContentType(normalized, destination),
                )
            } finally {
                temporary.delete()
            }
        }
    }

    override suspend fun writeText(path: String, content: String): TargetStat {
        val bytes = content.toByteArray(Charsets.UTF_8)
        return write(
            path = path,
            input = ByteArrayInputStream(bytes),
            expectedSize = bytes.size.toLong(),
            contentType = inferContentType(resolve(path), null),
        )
    }

    override suspend fun mkdir(path: String) {
        val normalized = resolve(path)
        requireWritablePath(normalized)
        val mount = mountFor(normalized)
            ?: throw TargetFsException("Path is outside writable Android target storage: $normalized")
        val directory = physicalFile(normalized)
            ?: throw TargetFsException("Path is outside writable Android target storage: $normalized")
        withContext(Dispatchers.IO) {
            quotaMutex.withLock {
                if (directory.isFile) throw TargetFsException("File exists: $normalized")
                val existed = directory.isDirectory
                val cleanupRoot = if (existed) null else highestMissingDirectory(directory, mount)
                if (!directory.mkdirs() && !directory.isDirectory) {
                    throw TargetFsException("Unable to create directory: $normalized")
                }
                try {
                    validateEntryQuota(normalized)
                } catch (error: Exception) {
                    cleanupRoot?.deleteRecursively()
                    throw error
                }
            }
        }
    }

    override suspend fun touch(path: String) {
        val normalized = resolve(path)
        requireWritableFile(normalized)
        val existing = statOrNull(normalized)
        if (existing?.isDirectory == true) throw TargetFsException("Is a directory: $normalized")
        if (existing?.isFile == true) {
            val file = physicalFile(normalized) ?: throw TargetFsException("No such file: $normalized")
            withContext(Dispatchers.IO) {
                if (!file.setLastModified(System.currentTimeMillis())) {
                    throw TargetFsException("Unable to update file: $normalized")
                }
            }
            return
        }
        writeText(normalized, "")
    }

    override suspend fun delete(path: String) {
        val normalized = resolve(path)
        if (normalized == HOME || normalized == TMP) {
            throw TargetFsException("Refusing to delete $normalized")
        }
        requireWritablePath(normalized)
        val physical = physicalFile(normalized) ?: throw TargetFsException("No such file or directory: $normalized")
        withContext(Dispatchers.IO) {
            if (!physical.exists()) throw TargetFsException("No such file or directory: $normalized")
            if (!physical.deleteRecursively()) throw TargetFsException("Unable to delete: $normalized")
        }
        mimeOverrides.keys.removeAll { it == normalized || it.startsWith("$normalized/") }
    }

    override suspend fun deleteEmptyDirectory(path: String): Boolean {
        val normalized = resolve(path)
        if (normalized == HOME || normalized == TMP) return false
        requireWritablePath(normalized)
        val directory = physicalFile(normalized)
            ?: throw TargetFsException("Path is outside writable Android target storage: $normalized")
        return withContext(Dispatchers.IO) {
            quotaMutex.withLock {
                if (!directory.isDirectory) return@withLock false
                directory.delete()
            }
        }
    }

    override suspend fun copy(source: String, destination: String): TargetStat {
        val sourcePath = resolve(source)
        val sourceStat = stat(sourcePath)
        if (!sourceStat.isFile) throw TargetFsException("Source is not a file: $sourcePath")
        var destinationPath = resolve(destination)
        val destinationStat = statOrNull(destinationPath)
        if (destinationStat?.isDirectory == true) {
            destinationPath = TargetPath.join(destinationPath, TargetPath.basename(sourcePath))
        }
        open(sourcePath).use { opened ->
            opened.open().use { input ->
                return write(destinationPath, input, opened.length, opened.contentType)
            }
        }
    }

    override suspend fun move(source: String, destination: String): TargetStat {
        val normalizedSource = resolve(source)
        requireWritablePath(normalizedSource)
        val copied = copy(normalizedSource, destination)
        delete(normalizedSource)
        return copied
    }

    override suspend fun search(
        path: String,
        query: String,
        include: String?,
    ): TargetSearchResult = withContext(Dispatchers.IO) {
        val normalized = resolve(path)
        val needle = query.trim()
        if (needle.isEmpty()) throw TargetFsException("Search query is required")
        val rootStat = stat(normalized)
        val candidates = if (rootStat.isFile) listOf(normalized) else allFiles(normalized)
        val matches = mutableListOf<TargetSearchMatch>()

        for (candidate in candidates) {
            currentCoroutineContext().ensureActive()
            if (!include.isNullOrBlank() && !globMatches(include, TargetPath.basename(candidate))) continue
            val candidateStat = statOrNull(candidate) ?: continue
            if (!candidateStat.isFile || candidateStat.eventProducing || candidateStat.size > MAX_SEARCH_FILE_BYTES) continue

            val text = try {
                open(candidate).use { opened ->
                    if (!isTextContentType(opened.contentType)) return@use null
                    decodeUtf8(readBounded(opened.open(), MAX_SEARCH_FILE_BYTES))
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                null
            } ?: continue
            text.lineSequence().forEachIndexed { index, line ->
                if (needle in line && matches.size < MAX_SEARCH_MATCHES) {
                    matches += TargetSearchMatch(candidate, index + 1, line.take(MAX_MATCH_CHARS))
                }
            }
            if (matches.size >= MAX_SEARCH_MATCHES) {
                return@withContext TargetSearchResult(matches, truncated = true)
            }
        }
        TargetSearchResult(matches, truncated = false)
    }

    override suspend fun allFiles(path: String): List<String> = withContext(Dispatchers.IO) {
        val normalized = resolve(path)
        val start = stat(normalized)
        if (start.isFile) return@withContext listOf(normalized)

        val files = mutableListOf<String>()
        val pending = ArrayDeque<String>().apply { add(normalized) }
        while (pending.isNotEmpty()) {
            currentCoroutineContext().ensureActive()
            val directory = pending.removeFirst()
            val listing = list(directory)
            listing.files.mapTo(files) { TargetPath.join(directory, it) }
            listing.directories.forEach { pending.addLast(TargetPath.join(directory, it)) }
        }
        files.sorted()
    }

    private fun virtualDirectories(): Set<String> = BASE_DIRECTORIES + runtime.directories

    private suspend fun statOrNull(path: String): TargetStat? = try {
        stat(path)
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        null
    }

    private fun physicalFile(path: String): File? {
        val mount = mountFor(path) ?: return null
        val relative = path.removePrefix(mount.virtualRoot).trimStart('/')
        val candidate = if (relative.isEmpty()) mount.physicalRoot else File(mount.physicalRoot, relative)
        val canonical = candidate.canonicalFile
        val rootPath = mount.physicalRoot.path
        if (canonical.path != rootPath && !canonical.path.startsWith("$rootPath${File.separator}")) {
            throw TargetFsException("Path escapes Android target storage: $path")
        }
        return canonical
    }

    private fun mountFor(path: String): Mount? = when {
        path == HOME || path.startsWith("$HOME/") -> Mount(HOME, persistentRoot, persistentByteLimit)
        path == TMP || path.startsWith("$TMP/") -> Mount(TMP, temporaryRoot, temporaryByteLimit)
        else -> null
    }

    private fun validateWriteQuota(path: String, destination: File, temporary: File, written: Long) {
        val mount = mountFor(path) ?: throw TargetFsException("Path is outside Android target storage: $path")
        var bytes = 0L
        var entries = 0
        mount.physicalRoot.walkTopDown().forEach { entry ->
            if (entry == mount.physicalRoot || entry == temporary) return@forEach
            entries += 1
            if (entry.isFile) bytes += entry.length()
        }
        val destinationBytes = destination.takeIf(File::isFile)?.length() ?: 0L
        val projectedBytes = bytes - destinationBytes + written
        val projectedEntries = entries + if (destination.exists()) 0 else 1
        if (projectedBytes > mount.byteLimit) {
            throw TargetFsException(
                "${mount.virtualRoot} storage limit exceeded (${mount.byteLimit} bytes)",
            )
        }
        if (projectedEntries > entryLimit) {
            throw TargetFsException("${mount.virtualRoot} entry limit exceeded ($entryLimit entries)")
        }
    }

    private fun validateEntryQuota(path: String) {
        val mount = mountFor(path) ?: throw TargetFsException("Path is outside Android target storage: $path")
        val entries = mount.physicalRoot.walkTopDown().count() - 1
        if (entries > entryLimit) {
            throw TargetFsException("${mount.virtualRoot} entry limit exceeded ($entryLimit entries)")
        }
    }

    private fun highestMissingDirectory(directory: File, mount: Mount): File {
        var highest = directory
        var parent = directory.parentFile
        while (parent != null && parent != mount.physicalRoot && !parent.exists()) {
            highest = parent
            parent = parent.parentFile
        }
        return highest
    }

    private fun requireWritablePath(path: String) {
        if (
            path != HOME && !path.startsWith("$HOME/") &&
            path != TMP && !path.startsWith("$TMP/")
        ) {
            throw TargetFsException("Read-only path: $path")
        }
    }

    private fun requireWritableFile(path: String) {
        requireWritablePath(path)
        if (path == HOME || path == TMP) throw TargetFsException("Is a directory: $path")
    }

    private fun normalizeContentType(contentType: String?): String? {
        val normalized = contentType?.trim()?.takeIf(String::isNotEmpty) ?: return null
        if (normalized.length > MAX_CONTENT_TYPE_CHARS || normalized.any(Char::isISOControl)) {
            throw TargetFsException("Invalid content type")
        }
        return normalized
    }

    private fun replaceFile(source: File, destination: File) {
        try {
            Files.move(
                source.toPath(),
                destination.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: Exception) {
            Files.move(source.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private fun inferContentType(path: String, file: File?): String {
        mimeOverrides[path]?.let { return it }
        val header = if (file?.isFile == true) {
            runCatching {
                FileInputStream(file).use { input ->
                    ByteArray(16).let { bytes ->
                        val count = input.read(bytes)
                        if (count <= 0) byteArrayOf() else bytes.copyOf(count)
                    }
                }
            }.getOrDefault(byteArrayOf())
        } else {
            byteArrayOf()
        }
        sniffContentType(header)?.let { return it }
        return extensionContentType(path)
    }

    private data class Mount(
        val virtualRoot: String,
        val physicalRoot: File,
        val byteLimit: Long,
    )

    companion object {
        const val HOME = TargetPath.HOME
        const val TMP = "/tmp"
        const val MAX_TARGET_FILE_BYTES = 64L * 1024 * 1024
        const val MAX_TEXT_READ_BYTES = 8L * 1024 * 1024
        const val MAX_PERSISTENT_BYTES = 256L * 1024 * 1024
        const val MAX_TEMPORARY_BYTES = 128L * 1024 * 1024
        const val MAX_ENTRIES_PER_MOUNT = 4_096
        private const val MAX_SEARCH_FILE_BYTES = 4L * 1024 * 1024
        private const val MAX_SEARCH_MATCHES = 200
        private const val MAX_MATCH_CHARS = 200
        private const val COPY_BUFFER_BYTES = 64 * 1024
        private const val MAX_CONTENT_TYPE_CHARS = 256
        private val BASE_DIRECTORIES = setOf("/", "/home", HOME, TMP)

        fun isTextContentType(contentType: String): Boolean {
            val normalized = contentType.substringBefore(';').trim().lowercase()
            return normalized.startsWith("text/") || normalized in setOf(
                "application/json",
                "application/yaml",
                "application/javascript",
                "application/x-javascript",
                "application/typescript",
                "application/toml",
                "application/xml",
                "application/x-httpd-php",
                "image/svg+xml",
            ) || normalized.endsWith("+json")
        }

        fun decodeUtf8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()

        private suspend fun readBounded(input: InputStream, maximum: Long): ByteArray {
            input.use { source ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(COPY_BUFFER_BYTES)
                var total = 0L
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val count = source.read(buffer)
                    if (count < 0) break
                    if (count == 0) continue
                    total += count
                    if (total > maximum) throw TargetFsException("File exceeds read limit")
                    output.write(buffer, 0, count)
                }
                return output.toByteArray()
            }
        }

        private fun sniffContentType(bytes: ByteArray): String? = when {
            bytes.size >= 3 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() &&
                bytes[2] == 0xff.toByte() -> "image/jpeg"
            bytes.size >= 8 && bytes.copyOfRange(0, 8).contentEquals(
                byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
            ) -> "image/png"
            bytes.size >= 6 && String(bytes.copyOfRange(0, 6), Charsets.US_ASCII).startsWith("GIF8") ->
                "image/gif"
            bytes.size >= 12 && String(bytes.copyOfRange(0, 4), Charsets.US_ASCII) == "RIFF" &&
                String(bytes.copyOfRange(8, 12), Charsets.US_ASCII) == "WEBP" -> "image/webp"
            else -> null
        }

        private fun extensionContentType(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
            "txt", "log", "tsv", "kt", "java", "rs" ->
                "text/plain; charset=utf-8"
            "md" -> "text/markdown; charset=utf-8"
            "csv" -> "text/csv; charset=utf-8"
            "css" -> "text/css; charset=utf-8"
            "sh" -> "text/x-shellscript; charset=utf-8"
            "py" -> "text/x-python; charset=utf-8"
            "html", "htm" -> "text/html; charset=utf-8"
            "json", "jsonl", "map" -> "application/json; charset=utf-8"
            "js", "mjs", "cjs", "jsx" -> "application/javascript; charset=utf-8"
            "ts", "tsx" -> "application/typescript; charset=utf-8"
            "xml" -> "application/xml; charset=utf-8"
            "svg" -> "image/svg+xml; charset=utf-8"
            "yaml", "yml" -> "application/yaml; charset=utf-8"
            "toml" -> "application/toml; charset=utf-8"
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "wav" -> "audio/wav"
            "m4a" -> "audio/mp4"
            "mp3" -> "audio/mpeg"
            "ogg" -> "audio/ogg"
            "mp4" -> "video/mp4"
            "mov" -> "video/quicktime"
            "webm" -> "audio/webm"
            "pdf" -> "application/pdf"
            "wasm" -> "application/wasm"
            "data" -> "application/octet-stream"
            else -> "text/plain; charset=utf-8"
        }

        private fun globMatches(pattern: String, value: String): Boolean {
            val regex = buildString {
                append('^')
                var index = 0
                while (index < pattern.length) {
                    when (val char = pattern[index]) {
                        '*' -> append(".*")
                        '?' -> append('.')
                        '{' -> {
                            val close = pattern.indexOf('}', startIndex = index + 1)
                            if (close > index) {
                                val alternatives = pattern.substring(index + 1, close)
                                    .split(',')
                                    .joinToString("|") { Regex.escape(it) }
                                append("(?:$alternatives)")
                                index = close
                            } else {
                                append("\\{")
                            }
                        }
                        else -> append(Regex.escape(char.toString()))
                    }
                    index += 1
                }
                append('$')
            }
            return Regex(regex).matches(value)
        }
    }
}
