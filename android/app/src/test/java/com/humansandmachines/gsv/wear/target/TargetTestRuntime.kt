package com.humansandmachines.gsv.wear.target

class TargetTestRuntime(
    private val content: Map<String, Pair<ByteArray, String>> = emptyMap(),
    override val directories: Set<String> = emptySet(),
) : TargetRuntimeFiles {
    override val files: Set<String> = content.keys

    override suspend fun stat(path: String): TargetStat? = content[path]?.let { (bytes, contentType) ->
        TargetStat(
            path = path,
            isFile = true,
            isDirectory = false,
            size = bytes.size.toLong(),
            contentType = contentType,
        )
    }

    override suspend fun open(path: String): TargetReadHandle? = content[path]?.let { (bytes, contentType) ->
        TargetReadHandle.fromBytes(path, bytes, contentType)
    }
}
