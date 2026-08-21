package com.humansandmachines.gsv.wear.target

object TargetPath {
    const val HOME = "/home/android"

    fun normalize(rawPath: String, cwd: String = HOME): String {
        val input = rawPath.trim()
        require(input.isNotEmpty()) { "Path is required" }
        require('\u0000' !in input) { "Path contains a null byte" }
        require(input.length <= MAX_PATH_LENGTH) { "Path is too long" }

        val expanded = when {
            input == "~" -> HOME
            input.startsWith("~/") -> "$HOME/${input.removePrefix("~/")}"
            else -> input
        }
        val absolute = if (expanded.startsWith('/')) {
            expanded
        } else {
            "${normalizeAbsolute(cwd)}/$expanded"
        }
        return normalizeAbsolute(absolute)
    }

    fun dirname(path: String): String {
        val normalized = normalize(path, "/")
        if (normalized == "/") return "/"
        val index = normalized.lastIndexOf('/')
        return if (index <= 0) "/" else normalized.substring(0, index)
    }

    fun basename(path: String): String {
        val normalized = normalize(path, "/")
        if (normalized == "/") return "/"
        return normalized.substring(normalized.lastIndexOf('/') + 1)
    }

    fun join(parent: String, child: String): String = normalize(
        "${normalize(parent, "/").trimEnd('/')}/$child",
        "/",
    )

    private fun normalizeAbsolute(path: String): String {
        val parts = ArrayDeque<String>()
        for (part in path.split('/')) {
            when (part) {
                "", "." -> Unit
                ".." -> if (parts.isNotEmpty()) parts.removeLast()
                else -> parts.addLast(part)
            }
        }
        return "/${parts.joinToString("/")}"
    }

    private const val MAX_PATH_LENGTH = 4_096
}
