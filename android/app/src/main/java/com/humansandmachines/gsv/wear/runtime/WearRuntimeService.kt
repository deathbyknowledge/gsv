package com.humansandmachines.gsv.wear.runtime

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import com.humansandmachines.gsv.wear.BuildConfig
import com.humansandmachines.gsv.wear.GsvWearApplication
import com.humansandmachines.gsv.wear.MainActivity
import com.humansandmachines.gsv.wear.R
import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.actions.AndroidActionController
import com.humansandmachines.gsv.wear.audio.AudioController
import com.humansandmachines.gsv.wear.audio.AuthorityBoundMicrophone
import com.humansandmachines.gsv.wear.audio.WearMicrophone
import com.humansandmachines.gsv.wear.camera.CameraController
import com.humansandmachines.gsv.wear.checks.LocalCheckScheduler
import com.humansandmachines.gsv.wear.config.DriverConfig
import com.humansandmachines.gsv.wear.config.DriverConfigStore
import com.humansandmachines.gsv.wear.connection.ConnectionState
import com.humansandmachines.gsv.wear.connection.ConnectionSupervisor
import com.humansandmachines.gsv.wear.device.DeviceContextController
import com.humansandmachines.gsv.wear.notifications.AndroidNotificationAccess
import com.humansandmachines.gsv.wear.protocol.GsvProtocol
import com.humansandmachines.gsv.wear.sensors.SensorController
import com.humansandmachines.gsv.wear.target.AndroidPlatformCommands
import com.humansandmachines.gsv.wear.target.AndroidTargetCommands
import com.humansandmachines.gsv.wear.target.AndroidTargetFileSystem
import com.humansandmachines.gsv.wear.target.PlatformAutomationCommands
import com.humansandmachines.gsv.wear.target.TargetShell
import com.humansandmachines.gsv.wear.target.WearMediaCommands
import com.humansandmachines.gsv.wear.target.WearTargetRuntimeFiles
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.json.JSONArray
import org.json.JSONObject

class WearRuntimeService : LifecycleService() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val authority = WearAuthority()
    private lateinit var camera: CameraController
    private lateinit var microphoneRecorder: AudioController
    private lateinit var microphone: WearMicrophone
    private lateinit var sensors: SensorController
    private lateinit var actions: AndroidActionController
    private lateinit var checks: LocalCheckScheduler
    private lateinit var targetFileSystem: AndroidTargetFileSystem
    private lateinit var dispatcherFactory: WearRequestDispatcherFactory
    private var connection: ConnectionSupervisor? = null
    private var connectionConfig: DriverConfig? = null
    private var foregroundStarted = false

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        WearRuntimeState.reset()
        camera = CameraController(
            context = applicationContext,
            lifecycleOwner = this,
            authority = authority,
            onState = { state ->
                WearRuntimeState.setCamera(state)
                refreshNotification()
            },
        )
        microphoneRecorder = AudioController(
            context = applicationContext,
            onState = { state ->
                WearRuntimeState.setMicrophone(state)
                refreshNotification()
            },
        )
        microphone = AuthorityBoundMicrophone(microphoneRecorder, authority)
        sensors = SensorController(applicationContext, authority)
        actions = AndroidActionController(applicationContext)
        val deviceContext = DeviceContextController(applicationContext)
        val notificationAccess = AndroidNotificationAccess(applicationContext)
        val platform = (application as GsvWearApplication).platformClient
        val runtimeFiles = WearTargetRuntimeFiles(authority, camera, ::deviceInfo, platform)
        targetFileSystem = AndroidTargetFileSystem(
            persistentRoot = File(filesDir, "gsv-target/home"),
            temporaryRoot = File(cacheDir, "gsv-target/tmp"),
            runtime = runtimeFiles,
        ).also(AndroidTargetFileSystem::clearTemporary)
        checks = LocalCheckScheduler(
            parentScope = serviceScope,
            fileSystem = targetFileSystem,
            authority = authority,
            stateFile = File(filesDir, "gsv-target/checks.json"),
        )
        val commands = AndroidTargetCommands.create(
            targetFileSystem,
            WearMediaCommands(authority, camera, microphone, sensors).commands() +
                AndroidPlatformCommands(deviceContext, actions, notificationAccess, authority, platform).commands() +
                PlatformAutomationCommands(platform, authority).commands() +
                checks.commands(),
        )
        val shell = TargetShell(targetFileSystem, commands)
        checks.attach(TargetShell(targetFileSystem, commands))
        val incomingDirectory = File(cacheDir, "gsv-target/incoming").also(::clearDirectory)
        dispatcherFactory = WearRequestDispatcherFactory(
            parentScope = serviceScope,
            fileSystem = targetFileSystem,
            incomingDirectory = incomingDirectory,
            shell = shell,
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            ACTION_ARM -> handleArm()
            ACTION_PAUSE -> {
                if (authority.pause()) {
                    dispatcherFactory.cancelAll()
                    checks.stop()
                    publishAuthority()
                }
            }
            ACTION_RESUME -> {
                if (authority.resume()) {
                    checks.start()
                    publishAuthority()
                }
            }
            ACTION_DISARM -> {
                authority.disarm()
                dispatcherFactory.cancelAll()
                checks.stop()
                publishAuthority()
            }
            ACTION_DISCONNECT -> disconnectRuntime()
            else -> stopSelf()
        }
        return Service.START_NOT_STICKY
    }

    override fun onDestroy() {
        authority.disarm()
        if (::dispatcherFactory.isInitialized) dispatcherFactory.cancelAll()
        if (::checks.isInitialized) checks.close()
        connection?.stop()
        connection = null
        connectionConfig = null
        if (::camera.isInitialized) camera.close()
        if (::microphoneRecorder.isInitialized) microphoneRecorder.close()
        if (::sensors.isInitialized) sensors.close()
        if (::actions.isInitialized) actions.close()
        if (::targetFileSystem.isInitialized) targetFileSystem.clearTemporary()
        serviceScope.cancel(CancellationException("Wear runtime destroyed"))
        WearRuntimeState.reset()
        super.onDestroy()
    }

    private fun handleArm() {
        if (!hasWearPermissions()) {
            stopSelf()
            return
        }
        if (!foregroundStarted) {
            try {
                ServiceCompat.startForeground(
                    this,
                    NOTIFICATION_ID,
                    buildNotification(),
                    foregroundServiceTypes(),
                )
                foregroundStarted = true
            } catch (_: SecurityException) {
                stopSelf()
                return
            }
        }

        val config = runCatching {
            DriverConfigStore(applicationContext).load(BuildConfig.DEBUG)
        }.getOrNull()
        if (config == null) {
            disconnectRuntime()
            return
        }

        dispatcherFactory.cancelAll()
        checks.stop()
        authority.arm()
        checks.start()
        publishAuthority()
        if (!sameConnection(config, connectionConfig)) {
            connection?.stop()
            startConnection(config)
        } else if (connection == null) {
            startConnection(config)
        }
    }

    private fun startConnection(config: DriverConfig) {
        connectionConfig = config
        connection = ConnectionSupervisor(
            context = applicationContext,
            scope = serviceScope,
            config = config,
            dispatcherFactory = dispatcherFactory,
            onStatus = { status ->
                WearRuntimeState.setConnection(status)
                refreshNotification()
            },
        ).also(ConnectionSupervisor::start)
    }

    private fun disconnectRuntime() {
        authority.disarm()
        dispatcherFactory.cancelAll()
        checks.stop()
        connection?.stop()
        connection = null
        connectionConfig = null
        WearRuntimeState.reset()
        if (foregroundStarted) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            foregroundStarted = false
        }
        stopSelf()
    }

    private fun publishAuthority() {
        WearRuntimeState.setAuthority(authority.state())
        refreshNotification()
    }

    private fun refreshNotification() {
        if (!foregroundStarted) return
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        try {
            NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, buildNotification())
        } catch (_: SecurityException) {
            // Permission can be revoked between the explicit check and notify().
        }
    }

    private fun buildNotification(): Notification {
        val snapshot = WearRuntimeState.snapshot.value
        val title = when (snapshot.authority) {
            AuthorityState.ARMED -> getString(R.string.notification_armed)
            AuthorityState.PAUSED -> getString(R.string.notification_paused)
            AuthorityState.DISARMED -> getString(R.string.notification_disarmed)
        }
        val content =
            "${snapshot.connection.displayName()} · Camera ${snapshot.camera.displayName()} · " +
                "Microphone ${snapshot.microphone.displayName()}"
        val builder = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL)
            .setSmallIcon(R.drawable.ic_gsv_wear)
            .setContentTitle(title)
            .setContentText(content)
            .setContentIntent(activityIntent())
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)

        when (snapshot.authority) {
            AuthorityState.ARMED -> {
                builder.addAction(0, getString(R.string.pause_wear), serviceIntent(ACTION_PAUSE, 1))
                builder.addAction(0, getString(R.string.disarm_wear), serviceIntent(ACTION_DISARM, 2))
            }
            AuthorityState.PAUSED -> {
                builder.addAction(0, getString(R.string.resume_wear), serviceIntent(ACTION_RESUME, 3))
                builder.addAction(0, getString(R.string.disarm_wear), serviceIntent(ACTION_DISARM, 2))
            }
            AuthorityState.DISARMED -> {
                builder.addAction(0, getString(R.string.notification_open), activityIntent())
                builder.addAction(
                    0,
                    getString(R.string.notification_disconnect),
                    serviceIntent(ACTION_DISCONNECT, 4),
                )
            }
        }
        return builder.build()
    }

    private fun activityIntent(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun serviceIntent(action: String, requestCode: Int): PendingIntent =
        PendingIntent.getService(
            this,
            requestCode,
            Intent(this, WearRuntimeService::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun hasWearPermissions(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED &&
            hasBluetoothPermission() &&
            canPostNotifications()

    private fun hasBluetoothPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) ==
            PackageManager.PERMISSION_GRANTED

    private fun canPostNotifications(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    private fun foregroundServiceTypes(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        } else {
            0
        }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL,
            getString(R.string.notification_channel),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.notification_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun sameConnection(first: DriverConfig, second: DriverConfig?): Boolean =
        second != null &&
            first.gatewayUrl == second.gatewayUrl &&
            first.username == second.username &&
            first.deviceId == second.deviceId &&
            first.token == second.token

    private fun deviceInfo(): JSONObject = JSONObject()
        .put("platform", "android")
        .put("manufacturer", Build.MANUFACTURER)
        .put("brand", Build.BRAND)
        .put("model", Build.MODEL)
        .put("androidRelease", Build.VERSION.RELEASE)
        .put("sdk", Build.VERSION.SDK_INT)
        .put("supportedAbis", JSONArray(Build.SUPPORTED_ABIS.toList()))
        .put("appVersion", BuildConfig.VERSION_NAME)
        .put("protocol", GsvProtocol.VERSION)

    private fun clearDirectory(directory: File) {
        directory.listFiles()?.forEach(File::deleteRecursively)
        if (!directory.mkdirs() && !directory.isDirectory) {
            throw IllegalStateException("Unable to create Android target transfer directory")
        }
    }

    private fun ConnectionState.displayName(): String = name.lowercase().replaceFirstChar(Char::uppercase)

    private fun CameraState.displayName(): String = name.lowercase().replaceFirstChar(Char::uppercase)

    private fun MicrophoneState.displayName(): String = name.lowercase().replaceFirstChar(Char::uppercase)

    companion object {
        private const val NOTIFICATION_CHANNEL = "gsv_wear_runtime"
        private const val NOTIFICATION_ID = 7101
        const val ACTION_ARM = "com.humansandmachines.gsv.wear.action.ARM"
        const val ACTION_PAUSE = "com.humansandmachines.gsv.wear.action.PAUSE"
        const val ACTION_RESUME = "com.humansandmachines.gsv.wear.action.RESUME"
        const val ACTION_DISARM = "com.humansandmachines.gsv.wear.action.DISARM"
        const val ACTION_DISCONNECT = "com.humansandmachines.gsv.wear.action.DISCONNECT"

        fun arm(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, WearRuntimeService::class.java).setAction(ACTION_ARM),
            )
        }

        fun command(context: Context, action: String) {
            context.startService(Intent(context, WearRuntimeService::class.java).setAction(action))
        }
    }
}
