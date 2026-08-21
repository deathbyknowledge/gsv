package com.humansandmachines.gsv.wear.target

import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody
import okio.BufferedSink
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class TargetNetHandler(
    private val temporaryDirectory: File,
    private val baseClient: OkHttpClient = OkHttpClient.Builder().build(),
) {
    suspend fun handle(args: JSONObject, body: TargetRequestBody?): TargetHandlerResponse {
        val request = parseRequest(args, body)
        val input = if (body == null) null else body.open()
        try {
            val response = execute(request, input)
            return response.use { spoolResponse(it) }
        } catch (error: CancellationException) {
            throw error
        } catch (error: TargetFsException) {
            throw error
        } catch (_: Exception) {
            throw TargetFsException("Android network request failed")
        } finally {
            input?.close()
        }
    }

    private fun parseRequest(args: JSONObject, body: TargetRequestBody?): PreparedRequest {
        val url = (args.opt("url") as? String)?.trim().orEmpty()
        if (url.isEmpty()) throw TargetFsException("net.fetch requires url")
        val scheme = runCatching { java.net.URI(url).scheme?.lowercase(Locale.ROOT) }.getOrNull()
        if (scheme != "http" && scheme != "https") {
            body?.cancel("net.fetch supports only HTTP and HTTPS")
            throw TargetFsException("net.fetch supports only HTTP and HTTPS")
        }

        val method = ((args.opt("method") as? String) ?: "GET").trim().uppercase(Locale.ROOT)
        if (!METHOD_PATTERN.matches(method)) {
            body?.cancel("net.fetch method is invalid")
            throw TargetFsException("net.fetch method is invalid")
        }
        if (body != null && method in BODY_FORBIDDEN_METHODS) {
            body.cancel("$method requests cannot carry a body")
            throw TargetFsException("$method requests cannot carry a body")
        }
        if ((body?.length ?: 0L) > MAX_BODY_BYTES) {
            body?.cancel("net.fetch request body exceeds $MAX_BODY_BYTES bytes")
            throw TargetFsException("net.fetch request body exceeds $MAX_BODY_BYTES bytes")
        }

        val timeoutMs = when (val value = args.opt("timeoutMs")) {
            null -> DEFAULT_TIMEOUT_MS
            is Int -> value.toLong()
            is Long -> value
            else -> throw TargetFsException("net.fetch timeoutMs must be an integer")
        }
        if (timeoutMs !in 1..MAX_TIMEOUT_MS) {
            throw TargetFsException("net.fetch timeoutMs must be between 1 and $MAX_TIMEOUT_MS")
        }

        val redirect = (args.opt("redirect") as? String) ?: "follow"
        if (redirect !in REDIRECT_MODES) throw TargetFsException("net.fetch redirect must be follow, error, or manual")

        val headerValue = args.opt("headers")
        if (headerValue != null && headerValue !== JSONObject.NULL && headerValue !is JSONObject) {
            throw TargetFsException("net.fetch headers must be an object")
        }
        val headers = Headers.Builder()
        (headerValue as? JSONObject)?.let { values ->
            for (name in values.keys()) {
                val value = values.opt(name) as? String
                    ?: throw TargetFsException("net.fetch header values must be strings")
                if (!HEADER_NAME_PATTERN.matches(name) || value.any { it == '\r' || it == '\n' }) {
                    throw TargetFsException("net.fetch contains an invalid header")
                }
                headers.add(name, value)
            }
        }

        return PreparedRequest(
            url = url,
            method = method,
            headers = headers.build(),
            redirect = redirect,
            timeoutMs = timeoutMs,
            body = body,
        )
    }

    private suspend fun execute(prepared: PreparedRequest, input: InputStream?): Response {
        val requestBody = when {
            prepared.body != null -> StreamingRequestBody(
                input = requireNotNull(input),
                length = prepared.body.length,
                contentType = prepared.headers["Content-Type"],
            )
            prepared.method in BODY_REQUIRED_METHODS -> ByteArray(0).toRequestBody(null)
            else -> null
        }
        val request = Request.Builder()
            .url(prepared.url)
            .headers(prepared.headers)
            .method(prepared.method, requestBody)
            .build()
        val follow = prepared.redirect == "follow"
        val client = baseClient.newBuilder()
            .followRedirects(follow)
            .followSslRedirects(follow)
            .callTimeout(prepared.timeoutMs, TimeUnit.MILLISECONDS)
            .build()
        val response = client.newCall(request).await()
        if (prepared.redirect == "error" && response.isRedirect) {
            response.close()
            throw TargetFsException("net.fetch redirect was rejected")
        }
        return response
    }

    private suspend fun spoolResponse(response: Response): TargetHandlerResponse = withContext(Dispatchers.IO) {
        if (!temporaryDirectory.mkdirs() && !temporaryDirectory.isDirectory) {
            throw TargetFsException("Unable to create network response directory")
        }
        val output = File.createTempFile("gsv-net-", ".body", temporaryDirectory)
        var keep = false
        try {
            response.body.writeBounded(output)
            val data = JSONObject()
                .put("ok", response.isSuccessful)
                .put("url", response.request.url.toString())
                .put("status", response.code)
                .put("statusText", response.message)
                .put("headers", response.headers.toJson())
                .put("redirected", response.priorResponse != null)
            val contentType = response.header("Content-Type") ?: "application/octet-stream"
            keep = true
            TargetHandlerResponse.Body(
                data = data,
                body = TargetReadHandle.fromFile(
                    path = response.request.url.toString(),
                    file = output,
                    contentType = contentType,
                    cleanup = output::delete,
                ),
            )
        } finally {
            if (!keep) output.delete()
        }
    }

    private suspend fun ResponseBody?.writeBounded(destination: File): Long {
        if (this == null) {
            if (!destination.createNewFile() && !destination.isFile) {
                throw TargetFsException("Unable to create network response body")
            }
            return 0
        }
        val declared = contentLength()
        if (declared > MAX_BODY_BYTES) throw TargetFsException("Network response exceeds $MAX_BODY_BYTES bytes")
        byteStream().use { input ->
            FileOutputStream(destination).use { output ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (count == 0) continue
                    total += count
                    if (total > MAX_BODY_BYTES) {
                        throw TargetFsException("Network response exceeds $MAX_BODY_BYTES bytes")
                    }
                    output.write(buffer, 0, count)
                }
                return total
            }
        }
    }

    private fun Headers.toJson(): JSONObject = JSONObject().apply {
        for (name in this@toJson.names()) {
            put(name.lowercase(Locale.ROOT), this@toJson.values(name).joinToString(", "))
        }
    }

    private data class PreparedRequest(
        val url: String,
        val method: String,
        val headers: Headers,
        val redirect: String,
        val timeoutMs: Long,
        val body: TargetRequestBody?,
    )

    private class StreamingRequestBody(
        private val input: InputStream,
        private val length: Long?,
        contentType: String?,
    ) : RequestBody() {
        private val mediaType = contentType?.toMediaTypeOrNull()
        private val written = AtomicBoolean(false)

        override fun contentType() = mediaType

        override fun contentLength(): Long = length ?: -1L

        override fun isOneShot(): Boolean = true

        override fun writeTo(sink: BufferedSink) {
            if (!written.compareAndSet(false, true)) throw IllegalStateException("Network request body cannot be replayed")
            val buffer = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count == 0) continue
                total += count
                if (total > MAX_BODY_BYTES || (length != null && total > length)) {
                    throw TargetFsException("Network request body exceeded its declared or maximum length")
                }
                sink.write(buffer, 0, count)
            }
            if (length != null && total != length) {
                throw TargetFsException("Network request body length $total did not match $length")
            }
        }
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { cancel() }
        enqueue(
            object : Callback {
                override fun onFailure(call: Call, e: java.io.IOException) {
                    if (continuation.isActive) continuation.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    if (continuation.isActive) {
                        continuation.resume(response) { _, value, _ -> value.close() }
                    } else {
                        response.close()
                    }
                }
            },
        )
    }

    companion object {
        const val MAX_BODY_BYTES = 32L * 1024 * 1024
        private const val DEFAULT_TIMEOUT_MS = 60_000L
        private const val MAX_TIMEOUT_MS = 10L * 60 * 1_000
        private val BODY_FORBIDDEN_METHODS = setOf("GET", "HEAD")
        private val BODY_REQUIRED_METHODS = setOf("POST", "PUT", "PATCH", "PROPPATCH", "REPORT")
        private val REDIRECT_MODES = setOf("follow", "error", "manual")
        private val METHOD_PATTERN = Regex("[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}")
        private val HEADER_NAME_PATTERN = Regex("[!#$%&'*+.^_`|~0-9A-Za-z-]+")
    }
}
