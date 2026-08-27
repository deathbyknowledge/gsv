package com.humansandmachines.gsv.wear.target

import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean

data class TargetStat(
    val path: String,
    val isFile: Boolean,
    val isDirectory: Boolean,
    val size: Long,
    val contentType: String? = null,
    val eventProducing: Boolean = false,
    val revision: String? = null,
)

data class TargetListing(
    val files: List<String>,
    val directories: List<String>,
)

data class TargetSearchMatch(
    val path: String,
    val line: Int,
    val content: String,
)

data class TargetSearchResult(
    val matches: List<TargetSearchMatch>,
    val truncated: Boolean,
)

class TargetFsException(message: String) : Exception(message)

class TargetReadHandle(
    val path: String,
    val length: Long,
    val contentType: String,
    val eventProducing: Boolean,
    val revision: String?,
    private val openStream: () -> InputStream,
    private val cleanup: () -> Unit,
) : AutoCloseable {
    private val opened = AtomicBoolean(false)
    private val closed = AtomicBoolean(false)

    fun open(): InputStream {
        check(!closed.get()) { "Target response body is already closed" }
        check(opened.compareAndSet(false, true)) { "Target response body can only be opened once" }
        return openStream()
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) cleanup()
    }

    companion object {
        fun fromBytes(
            path: String,
            bytes: ByteArray,
            contentType: String,
            eventProducing: Boolean = false,
            revision: String? = null,
        ): TargetReadHandle = TargetReadHandle(
            path = path,
            length = bytes.size.toLong(),
            contentType = contentType,
            eventProducing = eventProducing,
            revision = revision,
            openStream = { ByteArrayInputStream(bytes) },
            cleanup = {},
        )

        fun fromFile(
            path: String,
            file: File,
            contentType: String,
            eventProducing: Boolean = false,
            revision: String? = null,
            cleanup: () -> Unit = {},
        ): TargetReadHandle {
            val input = try {
                FileInputStream(file)
            } catch (error: Throwable) {
                runCatching(cleanup)
                throw error
            }
            return TargetReadHandle(
                path = path,
                length = input.channel.size(),
                contentType = contentType,
                eventProducing = eventProducing,
                revision = revision,
                openStream = { input },
                cleanup = {
                    try {
                        input.close()
                    } finally {
                        cleanup()
                    }
                },
            )
        }
    }
}

interface TargetRuntimeFiles {
    val directories: Set<String>
    val files: Set<String>

    suspend fun stat(path: String): TargetStat?

    suspend fun open(path: String): TargetReadHandle?
}

interface TargetFileSystem {
    fun resolve(path: String, cwd: String = TargetPath.HOME): String

    suspend fun stat(path: String): TargetStat

    suspend fun list(path: String): TargetListing

    suspend fun open(path: String): TargetReadHandle

    suspend fun write(
        path: String,
        input: InputStream,
        expectedSize: Long,
        contentType: String? = null,
    ): TargetStat

    suspend fun writeText(path: String, content: String): TargetStat

    suspend fun mkdir(path: String)

    suspend fun touch(path: String)

    suspend fun delete(path: String)

    suspend fun deleteEmptyDirectory(path: String): Boolean

    suspend fun copy(source: String, destination: String): TargetStat

    suspend fun move(source: String, destination: String): TargetStat

    suspend fun search(path: String, query: String, include: String? = null): TargetSearchResult

    suspend fun allFiles(path: String = "/"): List<String>
}
