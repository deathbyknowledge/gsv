package com.humansandmachines.gsv.wear.actions

import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.os.Build
import android.os.PersistableBundle
import android.os.VibrationEffect
import android.os.VibrationAttributes
import android.os.Vibrator
import android.os.VibratorManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import androidx.core.net.toUri
import com.humansandmachines.gsv.wear.MainActivity
import com.humansandmachines.gsv.wear.R
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class AndroidActionFailure(message: String) : Exception(message)

interface AndroidActions {
    fun apps(): JSONObject

    fun openApp(packageName: String): JSONObject

    fun openUri(uri: String, packageName: String?): JSONObject

    fun shareText(text: String, title: String?): JSONObject

    suspend fun shareFile(name: String, mimeType: String, input: InputStream, length: Long): JSONObject

    fun clipboardRead(): JSONObject

    fun clipboardWrite(text: String, sensitive: Boolean): JSONObject

    fun clipboardClear(): JSONObject

    suspend fun speak(text: String, languageTag: String?, rate: Float, pitch: Float): JSONObject

    fun vibrate(patternMillis: LongArray): JSONObject

    fun showNotification(title: String, text: String): JSONObject
}

class AndroidActionController(private val context: Context) : AndroidActions, Closeable {
    private val notificationIds = AtomicInteger(USER_NOTIFICATION_ID_START)
    private val speechMutex = Mutex()
    private var textToSpeech: TextToSpeech? = null

    init {
        createNotificationChannel()
    }

    override fun apps(): JSONObject {
        val manager = context.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val entries = manager.queryIntentActivities(launcher, PackageManager.MATCH_ALL)
            .asSequence()
            .map { resolveInfo -> resolveInfo.activityInfo.applicationInfo }
            .distinctBy(ApplicationInfo::packageName)
            .sortedBy { application -> manager.getApplicationLabel(application).toString().lowercase(Locale.ROOT) }
            .take(MAX_APPS)
            .map { application ->
                val label = manager.getApplicationLabel(application).toString().take(MAX_APP_LABEL_CHARS)
                JSONObject()
                    .put("package", application.packageName.take(MAX_PACKAGE_CHARS))
                    .put("label", label)
                    .put("enabled", application.enabled)
                    .put("system", application.flags and ApplicationInfo.FLAG_SYSTEM != 0)
            }
            .toList()
        return JSONObject().put("apps", JSONArray(entries)).put("count", entries.size)
    }

    override fun openApp(packageName: String): JSONObject {
        validatePackage(packageName)
        val intent = context.packageManager.getLaunchIntentForPackage(packageName)
            ?: throw AndroidActionFailure("App is unavailable or has no launch activity: $packageName")
        return launchOrNotify(intent, "Open app", packageName)
    }

    override fun openUri(uri: String, packageName: String?): JSONObject {
        val parsed = uri.toUri()
        val scheme = parsed.scheme?.lowercase(Locale.ROOT)
            ?: throw AndroidActionFailure("Intent URI requires a scheme")
        if (scheme in BLOCKED_URI_SCHEMES) throw AndroidActionFailure("Intent URI scheme is not allowed")
        val intent = Intent(Intent.ACTION_VIEW, parsed)
        packageName?.let {
            validatePackage(it)
            intent.setPackage(it)
        }
        if (intent.resolveActivity(context.packageManager) == null) {
            throw AndroidActionFailure("No app can handle the requested URI")
        }
        return launchOrNotify(intent, "Open link", parsed.host ?: scheme)
    }

    override fun shareText(text: String, title: String?): JSONObject {
        if (text.isEmpty()) throw AndroidActionFailure("Share text must not be empty")
        if (text.length > MAX_SHARE_TEXT_CHARS) throw AndroidActionFailure("Share text is too large")
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, text)
            .apply { title?.let { putExtra(Intent.EXTRA_SUBJECT, it) } }
        val chooser = Intent.createChooser(send, title ?: "Share from GSV")
        return launchOrNotify(chooser, "Share text", title ?: "GSV content")
    }

    override suspend fun shareFile(
        name: String,
        mimeType: String,
        input: InputStream,
        length: Long,
    ): JSONObject = withContext(Dispatchers.IO) {
        if (length !in 0..MAX_SHARE_FILE_BYTES) throw AndroidActionFailure("Shared file exceeds size limit")
        val safeName = name.substringAfterLast('/').replace(UNSAFE_FILENAME, "_").take(128)
            .ifBlank { "gsv-share.bin" }
        val shareRoot = File(context.cacheDir, "shares").also { root ->
            if (!root.mkdirs() && !root.isDirectory) throw AndroidActionFailure("Unable to create share directory")
            val cutoff = System.currentTimeMillis() - SHARE_RETENTION_MILLIS
            root.listFiles()?.filter { it.lastModified() < cutoff }?.forEach(File::deleteRecursively)
        }
        val directory = File(shareRoot, UUID.randomUUID().toString()).also { root ->
            if (!root.mkdir()) throw AndroidActionFailure("Unable to create share directory")
        }
        val output = File(directory, safeName)
        var total = 0L
        FileOutputStream(output).use { destination ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count == 0) continue
                total += count
                if (total > length || total > MAX_SHARE_FILE_BYTES) {
                    output.delete()
                    throw AndroidActionFailure("Shared file exceeded declared or maximum size")
                }
                destination.write(buffer, 0, count)
            }
        }
        if (total != length) {
            output.delete()
            throw AndroidActionFailure("Shared file length $total did not match $length")
        }
        val uri = FileProvider.getUriForFile(context, FILE_PROVIDER_AUTHORITY, output)
        val send = Intent(Intent.ACTION_SEND)
            .setType(mimeType)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val chooser = Intent.createChooser(send, "Share $safeName")
        launchOrNotify(chooser, "Share file", safeName)
            .put("name", safeName)
            .put("size", total)
            .put("contentType", mimeType)
    }

    override fun clipboardRead(): JSONObject {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        if (!isAppVisible()) {
            return JSONObject()
                .put("available", false)
                .put("reason", "Android allows clipboard reads only while GSV Wear is visible")
        }
        val clip = clipboard.primaryClip ?: return JSONObject().put("available", true).put("empty", true)
        val values = JSONArray()
        for (index in 0 until clip.itemCount.coerceAtMost(MAX_CLIP_ITEMS)) {
            val text = clip.getItemAt(index).coerceToText(context)?.toString().orEmpty()
            values.put(text.take(MAX_CLIP_CHARS))
        }
        return JSONObject()
            .put("available", true)
            .put("empty", values.length() == 0)
            .put("items", values)
            .put("label", clip.description.label?.toString()?.take(MAX_CLIP_LABEL_CHARS))
    }

    override fun clipboardWrite(text: String, sensitive: Boolean): JSONObject {
        if (text.length > MAX_CLIP_CHARS) throw AndroidActionFailure("Clipboard text is too large")
        val clip = ClipData.newPlainText("GSV", text)
        if (sensitive) {
            clip.description.extras = PersistableBundle().apply {
                putBoolean(ClipDescriptionCompat.EXTRA_IS_SENSITIVE, true)
            }
        }
        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
        return JSONObject().put("written", true).put("characters", text.length).put("sensitive", sensitive)
    }

    override fun clipboardClear(): JSONObject {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            clipboard.clearPrimaryClip()
        } else {
            clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
        }
        return JSONObject().put("cleared", true)
    }

    override suspend fun speak(
        text: String,
        languageTag: String?,
        rate: Float,
        pitch: Float,
    ): JSONObject {
        if (text.isBlank()) throw AndroidActionFailure("Speech text must not be blank")
        if (text.length > TextToSpeech.getMaxSpeechInputLength()) throw AndroidActionFailure("Speech text is too long")
        if (rate !in 0.25f..2.0f || pitch !in 0.25f..2.0f) {
            throw AndroidActionFailure("Speech rate and pitch must be between 0.25 and 2.0")
        }
        return speechMutex.withLock {
            val engine = textToSpeech ?: createTextToSpeech().also { textToSpeech = it }
            val locale = languageTag?.let(Locale::forLanguageTag) ?: Locale.getDefault()
            if (engine.setLanguage(locale) < TextToSpeech.LANG_AVAILABLE) {
                throw AndroidActionFailure("Requested speech language is unavailable")
            }
            engine.setSpeechRate(rate)
            engine.setPitch(pitch)
            try {
                withTimeout(MAX_SPEECH_MILLIS) { engine.awaitSpeak(text) }
            } catch (_: TimeoutCancellationException) {
                engine.stop()
                throw AndroidActionFailure("Speech timed out")
            }
            JSONObject()
                .put("spoken", true)
                .put("characters", text.length)
                .put("language", locale.toLanguageTag())
                .put("rate", rate.toDouble())
                .put("pitch", pitch.toDouble())
        }
    }

    override fun vibrate(patternMillis: LongArray): JSONObject {
        if (patternMillis.isEmpty() || patternMillis.size > MAX_VIBRATION_SEGMENTS) {
            throw AndroidActionFailure("Vibration pattern must contain 1 to $MAX_VIBRATION_SEGMENTS segments")
        }
        if (patternMillis.any { it !in 0..MAX_VIBRATION_SEGMENT_MILLIS } || patternMillis.sum() > MAX_VIBRATION_TOTAL_MILLIS) {
            throw AndroidActionFailure("Vibration pattern exceeds duration limits")
        }
        if (patternMillis.sum() <= 0L) throw AndroidActionFailure("Vibration pattern must contain a non-zero pulse")
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(VibratorManager::class.java).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        if (!vibrator.hasVibrator()) throw AndroidActionFailure("This device has no vibrator")
        val effect = if (patternMillis.size == 1) {
            VibrationEffect.createOneShot(patternMillis[0], VibrationEffect.DEFAULT_AMPLITUDE)
        } else {
            VibrationEffect.createWaveform(patternMillis, -1)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            vibrator.vibrate(
                effect,
                VibrationAttributes.createForUsage(VibrationAttributes.USAGE_NOTIFICATION),
            )
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(
                effect,
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).build(),
            )
        }
        return JSONObject().put("vibrating", true).put("patternMs", JSONArray(patternMillis.toList()))
    }

    override fun showNotification(title: String, text: String): JSONObject {
        if (title.isBlank() || title.length > MAX_NOTIFICATION_TITLE_CHARS) {
            throw AndroidActionFailure("Notification title is invalid")
        }
        if (text.isBlank() || text.length > MAX_NOTIFICATION_TEXT_CHARS) {
            throw AndroidActionFailure("Notification text is invalid")
        }
        val id = notificationIds.getAndUpdate { current ->
            if (current == Int.MAX_VALUE) USER_NOTIFICATION_ID_START else current + 1
        }
        val open = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, USER_NOTIFICATION_CHANNEL)
            .setSmallIcon(R.drawable.ic_gsv_wear)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(id, notification)
        return JSONObject().put("shown", true).put("notificationId", id)
    }

    override fun close() {
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        textToSpeech = null
    }

    private fun launchOrNotify(intent: Intent, title: String, detail: String): JSONObject {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (isAppVisible()) {
            return try {
                context.startActivity(intent)
                JSONObject().put("launched", true).put("requiresUserTap", false)
            } catch (_: Exception) {
                postLaunchNotification(intent, title, detail)
            }
        }
        return postLaunchNotification(intent, title, detail)
    }

    private fun postLaunchNotification(intent: Intent, title: String, detail: String): JSONObject {
        val id = notificationIds.getAndUpdate { current ->
            if (current == Int.MAX_VALUE) USER_NOTIFICATION_ID_START else current + 1
        }
        val pending = PendingIntent.getActivity(
            context,
            id,
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, USER_NOTIFICATION_CHANNEL)
            .setSmallIcon(R.drawable.ic_gsv_wear)
            .setContentTitle(title)
            .setContentText(detail)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(id, notification)
        return JSONObject()
            .put("launched", false)
            .put("requiresUserTap", true)
            .put("notificationId", id)
            .put("reason", "Android restricted this background activity launch")
    }

    private fun isAppVisible(): Boolean {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }

    private suspend fun createTextToSpeech(): TextToSpeech = withContext(Dispatchers.Main.immediate) {
        suspendCancellableCoroutine { continuation ->
            lateinit var engine: TextToSpeech
            engine = TextToSpeech(context) { status ->
                if (!continuation.isActive) {
                    engine.shutdown()
                } else if (status == TextToSpeech.SUCCESS) {
                    continuation.resume(engine)
                } else {
                    engine.shutdown()
                    continuation.resumeWithException(AndroidActionFailure("Text-to-speech initialization failed"))
                }
            }
            continuation.invokeOnCancellation { engine.shutdown() }
        }
    }

    private suspend fun TextToSpeech.awaitSpeak(text: String) = suspendCancellableCoroutine { continuation ->
        val id = UUID.randomUUID().toString()
        setOnUtteranceProgressListener(
            object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = Unit

                override fun onDone(utteranceId: String?) {
                    if (utteranceId == id && continuation.isActive) continuation.resume(Unit)
                }

                @Deprecated("Deprecated in Android")
                override fun onError(utteranceId: String?) {
                    if (utteranceId == id && continuation.isActive) {
                        continuation.resumeWithException(AndroidActionFailure("Text-to-speech failed"))
                    }
                }
            },
        )
        val result = speak(text, TextToSpeech.QUEUE_FLUSH, null, id)
        if (result != TextToSpeech.SUCCESS && continuation.isActive) {
            continuation.resumeWithException(AndroidActionFailure("Text-to-speech request was rejected"))
        }
        continuation.invokeOnCancellation { stop() }
    }

    private fun validatePackage(value: String) {
        if (!PACKAGE_PATTERN.matches(value)) throw AndroidActionFailure("Invalid Android package name")
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            USER_NOTIFICATION_CHANNEL,
            "GSV agent messages",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { description = "Messages and Android actions requested by your GSV agents." }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private object ClipDescriptionCompat {
        const val EXTRA_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE"
    }

    companion object {
        private const val FILE_PROVIDER_AUTHORITY = "com.humansandmachines.gsv.wear.files"
        private const val USER_NOTIFICATION_CHANNEL = "gsv_agent_messages"
        private const val USER_NOTIFICATION_ID_START = 7200
        private const val MAX_APPS = 512
        private const val MAX_APP_LABEL_CHARS = 512
        private const val MAX_PACKAGE_CHARS = 512
        private const val MAX_SHARE_TEXT_CHARS = 64 * 1024
        private const val MAX_SHARE_FILE_BYTES = 32L * 1024 * 1024
        private const val SHARE_RETENTION_MILLIS = 60L * 60 * 1_000
        private const val MAX_CLIP_ITEMS = 16
        private const val MAX_CLIP_CHARS = 64 * 1024
        private const val MAX_CLIP_LABEL_CHARS = 512
        private const val MAX_SPEECH_MILLIS = 120_000L
        private const val MAX_VIBRATION_SEGMENTS = 20
        private const val MAX_VIBRATION_SEGMENT_MILLIS = 10_000L
        private const val MAX_VIBRATION_TOTAL_MILLIS = 30_000L
        private const val MAX_NOTIFICATION_TITLE_CHARS = 160
        private const val MAX_NOTIFICATION_TEXT_CHARS = 4_000
        private val PACKAGE_PATTERN = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+")
        private val UNSAFE_FILENAME = Regex("[^A-Za-z0-9._-]")
        private val BLOCKED_URI_SCHEMES = setOf("file", "content", "intent", "javascript", "data")
    }
}
