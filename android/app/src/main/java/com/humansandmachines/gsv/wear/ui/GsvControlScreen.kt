package com.humansandmachines.gsv.wear.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText as Text
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.config.ConnectionFields
import com.humansandmachines.gsv.wear.connection.ConnectionState
import com.humansandmachines.gsv.wear.runtime.RuntimeSnapshot

data class ControlUiState(
    val setupNotice: String = "",
    val voiceNotice: String = "",
    val notificationStatus: String = "Not granted",
    val assistantSelected: Boolean = false,
    val deviceTokenStored: Boolean = false,
    val voiceTokenStored: Boolean = false,
    val voiceProvisioning: Boolean = false,
    val voiceTestRunning: Boolean = false,
    val setupError: Boolean = false,
    val voiceError: Boolean = false,
)

@Composable
fun GsvControlScreen(
    initialFields: ConnectionFields?,
    snapshot: RuntimeSnapshot,
    uiState: ControlUiState,
    onSaveConnection: (ConnectionFields, String) -> Boolean,
    onArm: (ConnectionFields, String) -> Boolean,
    onPauseOrResume: () -> Unit,
    onDisarm: () -> Unit,
    onDisconnect: () -> Unit,
    onActivationStarted: () -> Unit,
    onProvisionVoice: (ConnectionFields, String, String) -> Boolean,
    onChooseAssistant: () -> Unit,
    onTestVoice: () -> Unit,
    onOpenBatterySettings: () -> Unit,
    onOpenNotificationSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var gatewayUrl by rememberSaveable { mutableStateOf(initialFields?.gatewayUrl.orEmpty()) }
    var username by rememberSaveable { mutableStateOf(initialFields?.username.orEmpty()) }
    var deviceId by rememberSaveable { mutableStateOf(initialFields?.deviceId.orEmpty()) }
    var deviceToken by remember { mutableStateOf("") }
    var voicePassword by remember { mutableStateOf("") }
    var linkExpanded by rememberSaveable { mutableStateOf(!uiState.deviceTokenStored) }
    var assistantExpanded by rememberSaveable { mutableStateOf(false) }
    var systemExpanded by rememberSaveable { mutableStateOf(false) }

    val fields = ConnectionFields(
        gatewayUrl = gatewayUrl.trim(),
        username = username.trim(),
        deviceId = deviceId.trim(),
    )
    val connectionDetail = buildString {
        append(snapshot.connection.displayName())
        snapshot.connectionFailure?.let { append(" // ${it.displayName()}") }
    }
    val connectionColor = snapshot.connection.statusColor()
    val statusScrimHeight = WindowInsets.statusBars.asPaddingValues().calculateTopPadding() + 10.dp
    val navigationScrimHeight = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + 6.dp

    Box(modifier.fillMaxSize().background(GsvColor.Void)) {
        SignalBackdrop()
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(horizontal = 22.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(24.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("GSV // MOBILE NODE", style = GsvTextStyle.Kicker)
                    Spacer(Modifier.height(6.dp))
                    Text("Wear", style = GsvTextStyle.Hero)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text("LINK", style = GsvTextStyle.Kicker.copy(color = GsvColor.MutedDark))
                    Text(snapshot.connection.displayName().uppercase(), style = GsvTextStyle.Data.copy(color = connectionColor))
                }
            }

            Spacer(Modifier.height(22.dp))
            WearCore(
                authority = snapshot.authority,
                onArmRequested = {
                    if (onArm(fields, deviceToken)) deviceToken = ""
                },
                onActivationStarted = onActivationStarted,
            )
            Spacer(Modifier.height(18.dp))

            when (snapshot.authority) {
                AuthorityState.DISARMED -> GsvButton(
                    label = "Arm Wear Mode",
                    onClick = {
                        if (onArm(fields, deviceToken)) deviceToken = ""
                    },
                    modifier = Modifier.fillMaxWidth(),
                    tone = GsvButtonTone.PRIMARY,
                )
                AuthorityState.ARMED,
                AuthorityState.PAUSED,
                -> Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    GsvButton(
                        label = if (snapshot.authority == AuthorityState.PAUSED) "Resume" else "Pause",
                        onClick = onPauseOrResume,
                        modifier = Modifier.weight(1f),
                        tone = GsvButtonTone.SECONDARY,
                    )
                    GsvButton(
                        label = "Disarm",
                        onClick = onDisarm,
                        modifier = Modifier.weight(1f),
                        tone = GsvButtonTone.DANGER,
                    )
                }
            }

            Spacer(Modifier.height(17.dp))
            Text(
                text = "Arm it, put the phone away, and let GSV become a private sensor and action surface.",
                style = GsvTextStyle.Body.copy(textAlign = TextAlign.Center),
            )
            InlineNotice(
                text = uiState.setupNotice,
                modifier = Modifier.padding(top = 16.dp).semantics { liveRegion = LiveRegionMode.Polite },
                color = if (uiState.setupError) GsvColor.Red else GsvColor.Cyan,
            )

            Spacer(Modifier.height(30.dp))
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(GsvColor.Panel.copy(alpha = 0.58f))
                    .padding(horizontal = 17.dp, vertical = 16.dp),
            ) {
                StatusReadout("Gateway", connectionDetail, color = connectionColor)
                Spacer(Modifier.height(12.dp))
                StatusReadout("Camera", snapshot.camera.displayName(), color = snapshot.camera.activityColor())
                Spacer(Modifier.height(12.dp))
                StatusReadout("Microphone", snapshot.microphone.displayName(), color = snapshot.microphone.activityColor())
            }

            Spacer(Modifier.height(20.dp))
            GsvSectionHeader("01", "Identity link", linkExpanded, { linkExpanded = !linkExpanded })
            ExpandableSection(linkExpanded) {
                Text(
                    "Bind this phone to a driver identity. Credentials remain in Android Keystore-backed storage.",
                    style = GsvTextStyle.Body,
                )
                Spacer(Modifier.height(18.dp))
                GsvField(
                    label = "Gateway WebSocket",
                    value = gatewayUrl,
                    onValueChange = { gatewayUrl = it },
                    placeholder = "wss://your-gsv.example/ws",
                    keyboardType = KeyboardType.Uri,
                )
                Spacer(Modifier.height(14.dp))
                GsvField(
                    label = "Username",
                    value = username,
                    onValueChange = { username = it },
                    keyboardType = KeyboardType.Text,
                )
                Spacer(Modifier.height(14.dp))
                GsvField(
                    label = "Device ID",
                    value = deviceId,
                    onValueChange = { deviceId = it },
                    placeholder = "android-wear",
                    keyboardType = KeyboardType.Ascii,
                )
                Spacer(Modifier.height(14.dp))
                GsvField(
                    label = "Device token",
                    value = deviceToken,
                    onValueChange = { deviceToken = it },
                    placeholder = if (uiState.deviceTokenStored) "Stored securely — leave blank to keep" else "Required",
                    secret = true,
                    keyboardType = KeyboardType.Password,
                )
                Spacer(Modifier.height(18.dp))
                GsvButton(
                    label = "Save Identity",
                    onClick = {
                        if (onSaveConnection(fields, deviceToken)) deviceToken = ""
                    },
                    modifier = Modifier.fillMaxWidth(),
                    tone = GsvButtonTone.SECONDARY,
                )
                Spacer(Modifier.height(22.dp))
            }

            GsvSectionHeader("02", "Assistant", assistantExpanded, { assistantExpanded = !assistantExpanded })
            ExpandableSection(assistantExpanded) {
                AssistantCore(
                    state = snapshot.voiceTurn,
                    modifier = Modifier.align(Alignment.CenterHorizontally).size(190.dp),
                )
                StatusReadout(
                    label = "Voice link",
                    value = if (uiState.voiceTokenStored) snapshot.voiceConnection.displayName() else "Not configured",
                    color = if (uiState.voiceTokenStored) snapshot.voiceConnection.statusColor() else GsvColor.MutedDark,
                )
                Spacer(Modifier.height(12.dp))
                StatusReadout(
                    label = "OS assistant",
                    value = if (uiState.assistantSelected) "Selected" else "Not selected",
                    color = if (uiState.assistantSelected) GsvColor.Cyan else GsvColor.Amber,
                )
                Spacer(Modifier.height(18.dp))
                Text(
                    "The assistant can be invoked by Android's assistant gesture or a compatible headset voice command.",
                    style = GsvTextStyle.Body,
                )
                Spacer(Modifier.height(18.dp))
                GsvField(
                    label = "GSV password — one-time setup",
                    value = voicePassword,
                    onValueChange = { voicePassword = it },
                    placeholder = if (uiState.voiceTokenStored) "Voice token already stored" else "Create voice client token",
                    secret = true,
                    keyboardType = KeyboardType.Password,
                )
                Spacer(Modifier.height(14.dp))
                GsvButton(
                    label = if (uiState.voiceProvisioning) "Establishing Link…" else "Enable Voice Client",
                    onClick = {
                        if (onProvisionVoice(fields, deviceToken, voicePassword)) {
                            deviceToken = ""
                            voicePassword = ""
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !uiState.voiceProvisioning,
                    tone = GsvButtonTone.PRIMARY,
                )
                Spacer(Modifier.height(10.dp))
                GsvButton(
                    label = "Choose GSV as Assistant",
                    onClick = onChooseAssistant,
                    modifier = Modifier.fillMaxWidth(),
                    tone = GsvButtonTone.SECONDARY,
                )
                Spacer(Modifier.height(10.dp))
                GsvButton(
                    label = if (uiState.voiceTestRunning) "Voice Turn Active" else "Test Assistant",
                    onClick = onTestVoice,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !uiState.voiceTestRunning,
                    tone = GsvButtonTone.QUIET,
                )
                InlineNotice(
                    text = uiState.voiceNotice,
                    modifier = Modifier.padding(top = 14.dp).semantics { liveRegion = LiveRegionMode.Polite },
                    color = if (uiState.voiceError) GsvColor.Red else GsvColor.Cyan,
                )
                Spacer(Modifier.height(22.dp))
            }

            GsvSectionHeader("03", "System access", systemExpanded, { systemExpanded = !systemExpanded })
            ExpandableSection(systemExpanded) {
                StatusReadout(
                    label = "Notifications",
                    value = uiState.notificationStatus,
                    color = if (uiState.notificationStatus == "Ready") GsvColor.Cyan else GsvColor.Amber,
                )
                Spacer(Modifier.height(18.dp))
                Text(
                    "Allow notification access for agent actions, and unrestricted battery use for dependable screen-off reachability.",
                    style = GsvTextStyle.Body,
                )
                Spacer(Modifier.height(18.dp))
                GsvButton(
                    label = "Notification Access",
                    onClick = onOpenNotificationSettings,
                    modifier = Modifier.fillMaxWidth(),
                    tone = GsvButtonTone.SECONDARY,
                )
                Spacer(Modifier.height(10.dp))
                GsvButton(
                    label = "Battery Settings",
                    onClick = onOpenBatterySettings,
                    modifier = Modifier.fillMaxWidth(),
                    tone = GsvButtonTone.QUIET,
                )
                Spacer(Modifier.height(10.dp))
                GsvButton(
                    label = "Disconnect Runtime",
                    onClick = onDisconnect,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = snapshot.connection != ConnectionState.DISCONNECTED,
                    tone = GsvButtonTone.DANGER,
                )
                Spacer(Modifier.height(24.dp))
            }

            Spacer(Modifier.height(34.dp))
            Text("USER-OWNED // CAPABILITY-GATED // ALWAYS VISIBLE", style = GsvTextStyle.Kicker.copy(color = GsvColor.MutedDark))
            Spacer(Modifier.height(30.dp))
        }
        Box(
            Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .height(statusScrimHeight)
                .background(
                    Brush.verticalGradient(
                        listOf(GsvColor.Void, GsvColor.Void.copy(alpha = 0.92f), Color.Transparent),
                    ),
                ),
        )
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(navigationScrimHeight)
                .background(
                    Brush.verticalGradient(
                        listOf(Color.Transparent, GsvColor.Void.copy(alpha = 0.92f), GsvColor.Void),
                    ),
                ),
        )
    }
}

@Composable
private fun ExpandableSection(
    expanded: Boolean,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    AnimatedVisibility(
        visible = expanded,
        enter = fadeIn() + expandVertically(),
        exit = fadeOut() + shrinkVertically(),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
            content = content,
        )
    }
}

private fun Enum<*>.displayName(): String = name.lowercase().replace('_', ' ').replaceFirstChar(Char::uppercase)

private fun ConnectionState.statusColor(): Color = when (this) {
    ConnectionState.CONNECTED -> GsvColor.Cyan
    ConnectionState.CONNECTING,
    ConnectionState.RECONNECTING,
    -> GsvColor.Blue
    ConnectionState.OFFLINE -> GsvColor.Amber
    ConnectionState.DISCONNECTED -> GsvColor.MutedDark
}

private fun Enum<*>.activityColor(): Color = when (name) {
    "ACTIVE" -> GsvColor.Cyan
    "OPENING", "CLOSING" -> GsvColor.Blue
    else -> GsvColor.MutedDark
}
