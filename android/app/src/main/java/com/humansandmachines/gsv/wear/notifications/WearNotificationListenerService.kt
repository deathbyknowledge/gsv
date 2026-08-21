package com.humansandmachines.gsv.wear.notifications

import android.app.Notification
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationManagerCompat
import java.lang.ref.WeakReference
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.json.JSONObject

class NotificationAccessFailure(message: String) : Exception(message)

interface NotificationAccess {
    fun status(): JSONObject

    fun list(): JSONObject

    fun read(id: String): JSONObject

    fun dismiss(id: String): JSONObject

    fun action(id: String, actionIndex: Int): JSONObject

    fun reply(id: String, actionIndex: Int, text: String): JSONObject
}

class AndroidNotificationAccess(private val context: Context) : NotificationAccess {
    override fun status(): JSONObject = notificationAccessStatus(
        granted = WearNotificationBridge.isGranted(context),
        connected = WearNotificationBridge.connected(),
    )

    override fun list(): JSONObject {
        val notifications = WearNotificationBridge.notifications(context)
        return JSONObject()
            .put("notifications", JSONArray(notifications.map { it.toJson(context) }))
            .put("count", notifications.size)
    }

    override fun read(id: String): JSONObject =
        WearNotificationBridge.resolve(context, id).toJson(context)

    override fun dismiss(id: String): JSONObject {
        val notification = WearNotificationBridge.resolve(context, id)
        if (!notification.isClearable) throw NotificationAccessFailure("Notification cannot be dismissed")
        WearNotificationBridge.service().cancelNotification(notification.key)
        return JSONObject().put("dismissed", true).put("id", id)
    }

    override fun action(id: String, actionIndex: Int): JSONObject {
        val notification = WearNotificationBridge.resolve(context, id)
        val action = notification.notification.actions?.getOrNull(actionIndex)
            ?: throw NotificationAccessFailure("Notification action is unavailable")
        try {
            action.actionIntent.send()
        } catch (_: PendingIntent.CanceledException) {
            throw NotificationAccessFailure("Notification action expired")
        }
        return JSONObject()
            .put("invoked", true)
            .put("id", id)
            .put("actionIndex", actionIndex)
            .put("title", action.title?.toString())
    }

    override fun reply(id: String, actionIndex: Int, text: String): JSONObject {
        if (text.isBlank()) throw NotificationAccessFailure("Notification reply must not be blank")
        if (text.length > MAX_REPLY_CHARS) throw NotificationAccessFailure("Notification reply is too long")
        val notification = WearNotificationBridge.resolve(context, id)
        val action = notification.notification.actions?.getOrNull(actionIndex)
            ?: throw NotificationAccessFailure("Notification reply action is unavailable")
        val inputs = action.remoteInputs?.filter { it.allowFreeFormInput }?.toTypedArray()?.takeIf { it.isNotEmpty() }
            ?: throw NotificationAccessFailure("Notification action does not accept a reply")
        val results = android.os.Bundle().apply {
            inputs.forEach { input -> putCharSequence(input.resultKey, text) }
        }
        val intent = Intent()
        RemoteInput.addResultsToIntent(inputs, intent, results)
        try {
            action.actionIntent.send(context, 0, intent)
        } catch (_: PendingIntent.CanceledException) {
            throw NotificationAccessFailure("Notification reply action expired")
        }
        return JSONObject()
            .put("replied", true)
            .put("id", id)
            .put("actionIndex", actionIndex)
    }

    private fun StatusBarNotification.toJson(context: Context): JSONObject {
        val extras = notification.extras
        val actions = JSONArray()
        notification.actions?.take(MAX_ACTIONS)?.forEachIndexed { index, action ->
            actions.put(
                JSONObject()
                    .put("index", index)
                    .put("title", bounded(action.title))
                    .put("allowsReply", action.remoteInputs?.any { it.allowFreeFormInput } == true),
            )
        }
        val appLabel = runCatching {
            val application = context.packageManager.getApplicationInfo(packageName, 0)
            context.packageManager.getApplicationLabel(application).toString()
        }.getOrDefault(packageName)
        return JSONObject()
            .put("id", WearNotificationBridge.publicId(key))
            .put("package", packageName.take(MAX_IDENTIFIER_CHARS))
            .put("app", appLabel.take(MAX_IDENTIFIER_CHARS))
            .put("title", bounded(extras.getCharSequence(Notification.EXTRA_TITLE)))
            .put("text", bounded(extras.getCharSequence(Notification.EXTRA_TEXT)))
            .put("bigText", bounded(extras.getCharSequence(Notification.EXTRA_BIG_TEXT)))
            .put("subText", bounded(extras.getCharSequence(Notification.EXTRA_SUB_TEXT)))
            .put("category", notification.category?.take(MAX_IDENTIFIER_CHARS))
            .put("postedAt", postTime)
            .put("ongoing", isOngoing)
            .put("clearable", isClearable)
            .put("group", notification.group?.take(MAX_IDENTIFIER_CHARS))
            .put("actions", actions)
    }

    private fun bounded(value: CharSequence?): String = value?.toString().orEmpty().take(MAX_TEXT_CHARS)

    companion object {
        private const val MAX_REPLY_CHARS = 8_000
        private const val MAX_TEXT_CHARS = 16 * 1024
        private const val MAX_IDENTIFIER_CHARS = 512
        private const val MAX_ACTIONS = 32
    }
}

internal fun notificationAccessStatus(granted: Boolean, connected: Boolean): JSONObject = JSONObject()
    .put("granted", granted)
    .put("connected", connected)
    .put("usable", granted && connected)
    .put("setupRequired", !granted)
    .put("settingsAction", Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
    .put(
        "detail",
        when {
            !granted -> "Enable GSV Wear under Android Notification access"
            !connected -> "Notification access is granted; waiting for Android to connect the listener"
            else -> "Notification access is ready"
        },
    )

class WearNotificationListenerService : NotificationListenerService() {
    override fun onListenerConnected() {
        super.onListenerConnected()
        WearNotificationBridge.attach(this)
    }

    override fun onListenerDisconnected() {
        WearNotificationBridge.detach(this)
        super.onListenerDisconnected()
    }

    override fun onDestroy() {
        WearNotificationBridge.detach(this)
        super.onDestroy()
    }
}

private object WearNotificationBridge {
    private var reference = WeakReference<WearNotificationListenerService>(null)
    private val keys = ConcurrentHashMap<String, String>()

    @Synchronized
    fun attach(service: WearNotificationListenerService) {
        reference = WeakReference(service)
    }

    @Synchronized
    fun detach(service: WearNotificationListenerService) {
        if (reference.get() === service) reference.clear()
        keys.clear()
    }

    fun isGranted(context: Context): Boolean =
        context.packageName in NotificationManagerCompat.getEnabledListenerPackages(context)

    fun connected(): Boolean = reference.get() != null

    fun service(): WearNotificationListenerService = reference.get()
        ?: throw NotificationAccessFailure("Notification access is not connected")

    fun notifications(context: Context): List<StatusBarNotification> {
        if (!isGranted(context)) throw NotificationAccessFailure("Notification access has not been granted in Android settings")
        val active = service().activeNotifications
            .filter { it.packageName != context.packageName }
            .sortedByDescending(StatusBarNotification::getPostTime)
            .take(MAX_NOTIFICATIONS)
        keys.clear()
        active.forEach { notification -> keys[publicId(notification.key)] = notification.key }
        return active
    }

    fun resolve(context: Context, id: String): StatusBarNotification {
        notifications(context)
        val key = keys[id] ?: throw NotificationAccessFailure("Notification is no longer available")
        return service().activeNotifications.firstOrNull { it.key == key }
            ?: throw NotificationAccessFailure("Notification is no longer available")
    }

    fun publicId(key: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
        return digest.take(12).joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }

    private const val MAX_NOTIFICATIONS = 512
}
