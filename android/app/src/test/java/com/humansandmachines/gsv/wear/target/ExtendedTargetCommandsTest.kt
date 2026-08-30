package com.humansandmachines.gsv.wear.target

import com.humansandmachines.gsv.wear.actions.AndroidActions
import com.humansandmachines.gsv.wear.audio.CapturedAudio
import com.humansandmachines.gsv.wear.audio.WearMicrophone
import com.humansandmachines.gsv.wear.authority.AuthorityLease
import com.humansandmachines.gsv.wear.authority.WearAuthority
import com.humansandmachines.gsv.wear.camera.CapturedObservation
import com.humansandmachines.gsv.wear.camera.CapturedSnapshot
import com.humansandmachines.gsv.wear.camera.ObservingCamera
import com.humansandmachines.gsv.wear.device.CurrentLocationRequest
import com.humansandmachines.gsv.wear.device.DeviceContextSource
import com.humansandmachines.gsv.wear.device.LocationProviderPreference
import com.humansandmachines.gsv.wear.notifications.NotificationAccess
import com.humansandmachines.gsv.wear.platform.GsvDisplaySize
import com.humansandmachines.gsv.wear.platform.GsvForegroundActivity
import com.humansandmachines.gsv.wear.platform.GsvPlatformCapture
import com.humansandmachines.gsv.wear.platform.GsvPlatformOperations
import com.humansandmachines.gsv.wear.platform.GsvPlatformStatus
import com.humansandmachines.gsv.wear.sensors.WearSensors
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ExtendedTargetCommandsTest {
    private lateinit var root: File
    private lateinit var fileSystem: AndroidTargetFileSystem
    private lateinit var shell: TargetShell
    private lateinit var authority: WearAuthority
    private lateinit var fakeDevice: FakeDevice
    private lateinit var fakePlatform: FakePlatform

    @Before
    fun setUp() {
        root = Files.createTempDirectory("gsv-android-extended-").toFile()
        fileSystem = AndroidTargetFileSystem(
            persistentRoot = File(root, "home"),
            temporaryRoot = File(root, "tmp"),
            runtime = TargetTestRuntime(
                content = mapOf(
                    WearTargetRuntimeFiles.PROC_WEAR_STATUS to (
                        """{"camera":"closed","microphone":"closed"}""".toByteArray() to
                            "application/json; charset=utf-8"
                        ),
                    WearTargetRuntimeFiles.SCREEN_SCREENSHOT to (
                        byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47) to "image/png"
                        ),
                ),
            ),
        )
        authority = WearAuthority { "lease" }.also { it.arm() }
        fakeDevice = FakeDevice()
        fakePlatform = FakePlatform(root)
        val commands = AndroidTargetCommands.create(
            fileSystem,
            WearMediaCommands(authority, FakeCamera(root), FakeMicrophone(root), FakeSensors()).commands() +
                AndroidPlatformCommands(
                    fakeDevice,
                    FakeActions(),
                    FakeNotifications(),
                    authority,
                    fakePlatform,
                ).commands() +
                PlatformAutomationCommands(fakePlatform, authority).commands() +
                TargetCommand(
                    name = "checks",
                    description = "test checks",
                    usage = "checks status",
                ) { _, _ -> TargetCommandResult(stdout = "{}\n") },
        )
        shell = TargetShell(fileSystem, commands)
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    @Test
    fun discoveryIncludesTheCompleteAndroidCapabilityFamilies() = runBlocking {
        val result = shell.execute(JSONObject().put("input", "commands --json"))

        val catalog = JSONArray(result.getString("output"))
        val names = List(catalog.length()) { catalog.getJSONObject(it).getString("name") }.toSet()
        assertTrue(
            setOf(
                "camera",
                "microphone",
                "sensors",
                "imu",
                "gesture",
                "orientation",
                "device",
                "location",
                "apps",
                "screen",
                "input",
                "intent",
                "share",
                "clipboard",
                "notifications",
                "notify",
                "speak",
                "vibrate",
                "checks",
            ).all(names::contains),
        )
    }

    @Test
    fun cameraObservationAndAudioCaptureMaterializeIntoTheVirtualFilesystem() = runBlocking {
        val camera = shell.execute(
            JSONObject().put(
                "input",
                "camera observe 1s /tmp/observe --interval 500ms --frames 2",
            ),
        )
        val microphone = shell.execute(
            JSONObject().put(
                "input",
                "microphone observe 1s /tmp/sample.wav --events speech,doorbell",
            ),
        )

        assertEquals("completed", camera.getString("status"))
        assertEquals(2, JSONObject(camera.getString("output")).getInt("frameCount"))
        assertEquals(3, fileSystem.list("/tmp/observe").files.size)
        assertEquals("completed", microphone.getString("status"))
        assertEquals("audio/wav", fileSystem.stat("/tmp/sample.wav").contentType)
        assertTrue(fileSystem.stat("/tmp/sample.json").size > 0)
        val analysis = JSONObject(microphone.getString("output")).getJSONObject("analysis")
        assertTrue(analysis.getJSONObject("requestedEventDetections").getBoolean("speech"))
        assertEquals("doorbell", analysis.getJSONArray("requiresSemanticInference").getString(0))
    }

    @Test
    fun platformCommandsRouteThroughTheirOwningControllers() = runBlocking {
        val device = shell.execute(JSONObject().put("input", "device battery"))
        val app = shell.execute(JSONObject().put("input", "apps open com.example.app"))
        val notification = shell.execute(JSONObject().put("input", "notifications reply abc 1 okay"))
        val output = shell.execute(JSONObject().put("input", "notify title body"))

        assertEquals("battery", JSONObject(device.getString("output")).getString("kind"))
        assertEquals("com.example.app", JSONObject(app.getString("output")).getString("package"))
        assertEquals("okay", JSONObject(notification.getString("output")).getString("text"))
        assertEquals("title", JSONObject(output.getString("output")).getString("title"))
        assertEquals("com.example.app", fakePlatform.launchedPackage)
    }

    @Test
    fun osAutomationCommandsAreBoundedAndMaterializeScreenshots() = runBlocking {
        val status = shell.execute(JSONObject().put("input", "screen status"))
        val screenshot = shell.execute(JSONObject().put("input", "screen screenshot /tmp/display.png"))
        val tap = shell.execute(JSONObject().put("input", "input tap 12 34"))
        val swipe = shell.execute(JSONObject().put("input", "input swipe 10 20 30 40 250ms"))
        val key = shell.execute(JSONObject().put("input", "input key HOME"))
        val text = shell.execute(JSONObject().put("input", "input text 'hello world'"))
        val foreground = shell.execute(JSONObject().put("input", "apps foreground"))

        assertEquals(1080, JSONObject(status.getString("output")).getInt("width"))
        assertEquals("image/png", fileSystem.stat("/tmp/display.png").contentType)
        assertEquals("completed", screenshot.getString("status"))
        assertEquals(12 to 34, fakePlatform.lastTap)
        assertEquals(listOf(10, 20, 30, 40, 250), fakePlatform.lastSwipe)
        assertEquals("HOME", fakePlatform.lastKey)
        assertEquals("hello world", fakePlatform.lastText)
        assertEquals("completed", tap.getString("status"))
        assertEquals("completed", swipe.getString("status"))
        assertEquals("completed", key.getString("status"))
        assertEquals("completed", text.getString("status"))
        assertEquals(
            "com.example.foreground",
            JSONObject(foreground.getString("output")).getString("package"),
        )
    }

    @Test
    fun osAutomationFailsClosedWhenWearModeIsDisarmed() = runBlocking {
        authority.disarm()

        val input = shell.execute(JSONObject().put("input", "input tap 12 34"))
        val foreground = shell.execute(JSONObject().put("input", "apps foreground"))

        assertEquals("failed", input.getString("status"))
        assertTrue(input.getString("error").contains("Wear Mode is not armed"))
        assertEquals("failed", foreground.getString("status"))
        assertTrue(foreground.getString("error").contains("Wear Mode is not armed"))
    }

    @Test
    fun locationFailsClosedWhenWearModeIsDisarmed() = runBlocking {
        authority.disarm()

        val result = shell.execute(JSONObject().put("input", "location current"))

        assertEquals("failed", result.getString("status"))
        assertTrue(result.getString("error").contains("Wear Mode is not armed"))
    }

    @Test
    fun locationOptionsReachTheDeviceBoundary() = runBlocking {
        val result = shell.execute(
            JSONObject().put(
                "input",
                "location current --provider gps --max-age 5s --force --timeout 30s",
            ),
        )

        assertEquals("completed", result.getString("status"))
        val request = fakeDevice.lastLocationRequest
        assertEquals(LocationProviderPreference.GPS, request.provider)
        assertEquals(5_000L, request.maxAgeMillis)
        assertEquals(30_000L, request.timeoutMillis)
        assertTrue(request.forceNewFix)
        assertFalse(request.allowCachedFallback)
    }

    @Test
    fun forcedLocationRejectsCachedFallback() = runBlocking {
        val result = shell.execute(
            JSONObject().put("input", "location current --force --allow-cached"),
        )

        assertEquals("failed", result.getString("status"))
        assertTrue(result.getString("error").contains("cannot be combined"))
    }

    private class FakeCamera(private val root: File) : ObservingCamera {
        override suspend fun capture(lease: AuthorityLease): CapturedSnapshot = snapshot(0)

        override suspend fun observe(
            lease: AuthorityLease,
            durationMillis: Long,
            intervalMillis: Long,
            maximumFrames: Int,
        ): CapturedObservation = CapturedObservation(
            snapshots = List(maximumFrames) { snapshot(it) },
            startedAtMillis = 1_000,
            completedAtMillis = 2_000,
        )

        private fun snapshot(index: Int): CapturedSnapshot {
            val file = File.createTempFile("frame-$index-", ".jpg", root)
            file.writeBytes(byteArrayOf(0xff.toByte(), 0xd8.toByte(), index.toByte()))
            return CapturedSnapshot(file)
        }
    }

    private class FakeMicrophone(private val root: File) : WearMicrophone {
        override suspend fun sample(lease: AuthorityLease, durationMillis: Long): CapturedAudio = audio()

        override suspend fun observe(lease: AuthorityLease, durationMillis: Long): CapturedAudio = audio()

        override suspend fun listenUntilSpeech(
            lease: AuthorityLease,
            timeoutMillis: Long,
            trailingMillis: Long,
            preferredDevice: android.media.AudioDeviceInfo?,
            onLevel: (Float) -> Unit,
        ): CapturedAudio = audio()

        private fun audio(): CapturedAudio {
            val file = File.createTempFile("audio-", ".wav", root)
            file.writeBytes("RIFFfake".toByteArray())
            return CapturedAudio(file, JSONObject().put("speechDetected", true))
        }
    }

    private class FakeSensors : WearSensors {
        override fun status(): JSONObject = JSONObject().put("accelerometer", true)

        override suspend fun sampleImu(lease: AuthorityLease, durationMillis: Long): JSONObject =
            JSONObject().put("kind", "imu")

        override suspend fun gestureSession(lease: AuthorityLease, durationMillis: Long): JSONObject =
            JSONObject().put("kind", "gesture")

        override suspend fun orientation(lease: AuthorityLease, durationMillis: Long): JSONObject =
            JSONObject().put("kind", "orientation")
    }

    private class FakeDevice : DeviceContextSource {
        lateinit var lastLocationRequest: CurrentLocationRequest

        override fun status(): JSONObject = JSONObject().put("kind", "status")

        override fun battery(): JSONObject = JSONObject().put("kind", "battery")

        override fun network(): JSONObject = JSONObject().put("kind", "network")

        override fun thermal(): JSONObject = JSONObject().put("kind", "thermal")

        override suspend fun currentLocation(request: CurrentLocationRequest): JSONObject {
            lastLocationRequest = request
            return JSONObject().put("kind", "location")
        }
    }

    private class FakePlatform(private val root: File) : GsvPlatformOperations {
        override val status = GsvPlatformStatus(
            apiVersion = 2,
            serviceVersion = "test",
            startedElapsedRealtimeMillis = 1,
        )
        var launchedPackage: String? = null
        var lastTap: Pair<Int, Int>? = null
        var lastSwipe: List<Int>? = null
        var lastKey: String? = null
        var lastText: String? = null

        override suspend fun displaySize(): GsvDisplaySize = GsvDisplaySize(1080, 2400)

        override suspend fun captureScreenshot(maxDimension: Int): GsvPlatformCapture {
            val file = File.createTempFile("screen-", ".png", root)
            file.writeBytes(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47))
            return GsvPlatformCapture(file, "image/png")
        }

        override suspend fun foregroundActivity(): GsvForegroundActivity =
            GsvForegroundActivity("com.example.foreground", "com.example.foreground.MainActivity")

        override suspend fun launchApp(packageName: String) {
            launchedPackage = packageName
        }

        override suspend fun tap(x: Int, y: Int) {
            lastTap = x to y
        }

        override suspend fun swipe(
            startX: Int,
            startY: Int,
            endX: Int,
            endY: Int,
            durationMillis: Int,
        ) {
            lastSwipe = listOf(startX, startY, endX, endY, durationMillis)
        }

        override suspend fun pressKey(keyName: String) {
            lastKey = keyName
        }

        override suspend fun typeText(text: String) {
            lastText = text
        }
    }

    private class FakeActions : AndroidActions {
        override fun apps(): JSONObject = JSONObject().put("apps", JSONArray())

        override fun openApp(packageName: String): JSONObject = JSONObject().put("package", packageName)

        override fun openUri(uri: String, packageName: String?): JSONObject = JSONObject().put("uri", uri)

        override fun shareText(text: String, title: String?): JSONObject = JSONObject().put("text", text)

        override suspend fun shareFile(
            name: String,
            mimeType: String,
            input: InputStream,
            length: Long,
        ): JSONObject = JSONObject().put("name", name).put("size", input.readBytes().size)

        override fun clipboardRead(): JSONObject = JSONObject().put("text", "clip")

        override fun clipboardWrite(text: String, sensitive: Boolean): JSONObject = JSONObject().put("text", text)

        override fun clipboardClear(): JSONObject = JSONObject().put("cleared", true)

        override suspend fun speak(
            text: String,
            languageTag: String?,
            rate: Float,
            pitch: Float,
        ): JSONObject = JSONObject().put("text", text)

        override fun vibrate(patternMillis: LongArray): JSONObject = JSONObject().put("segments", patternMillis.size)

        override fun showNotification(title: String, text: String): JSONObject = JSONObject().put("title", title)
    }

    private class FakeNotifications : NotificationAccess {
        override fun status(): JSONObject = JSONObject().put("granted", true)

        override fun list(): JSONObject = JSONObject().put("notifications", JSONArray())

        override fun read(id: String): JSONObject = JSONObject().put("id", id)

        override fun dismiss(id: String): JSONObject = JSONObject().put("id", id)

        override fun action(id: String, actionIndex: Int): JSONObject = JSONObject().put("index", actionIndex)

        override fun reply(id: String, actionIndex: Int, text: String): JSONObject = JSONObject().put("text", text)
    }
}
