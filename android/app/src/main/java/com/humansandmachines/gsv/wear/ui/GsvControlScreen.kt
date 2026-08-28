package com.humansandmachines.gsv.wear.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText as Text
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.connection.ConnectionState
import com.humansandmachines.gsv.wear.gesture.GestureLinkState
import com.humansandmachines.gsv.wear.gesture.GestureSnapshot
import com.humansandmachines.gsv.wear.runtime.RuntimeSnapshot
import com.humansandmachines.gsv.wear.voice.AssistantSnapshot
import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

data class ControlUiState(
    val runtimeNotice: String = "",
    val notificationStatus: String = "Not granted",
    val assistantSelected: Boolean = false,
    val runtimeError: Boolean = false,
)

private enum class GsvSurface {
    MIND,
    SHIP,
}

@Composable
fun GsvControlScreen(
    wearSnapshot: RuntimeSnapshot,
    assistantSnapshot: AssistantSnapshot,
    uiState: ControlUiState,
    onMindToggle: () -> Unit,
    onArm: () -> Unit,
    onPauseOrResume: () -> Unit,
    onDisarm: () -> Unit,
    onDisconnect: () -> Unit,
    onActivationStarted: () -> Unit,
    onChooseAssistant: () -> Unit,
    onOpenBatterySettings: () -> Unit,
    onOpenNotificationSettings: () -> Unit,
    gestureSnapshot: GestureSnapshot = GestureSnapshot(),
    onMindVisibilityChanged: (Boolean) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var selectedIndex by rememberSaveable { mutableIntStateOf(0) }
    var settingsVisible by rememberSaveable { mutableStateOf(false) }
    val selected = GsvSurface.entries[selectedIndex.coerceIn(GsvSurface.entries.indices)]
    BackHandler(enabled = settingsVisible) { settingsVisible = false }
    LaunchedEffect(selected, settingsVisible) {
        onMindVisibilityChanged(selected == GsvSurface.MIND && !settingsVisible)
    }
    DisposableEffect(Unit) {
        onDispose { onMindVisibilityChanged(false) }
    }

    val accent = when (selected) {
        GsvSurface.MIND -> assistantSnapshot.turn.accentColor()
        GsvSurface.SHIP -> when (wearSnapshot.authority) {
            AuthorityState.ARMED -> GsvColor.Accent
            AuthorityState.PAUSED -> GsvColor.Amber
            AuthorityState.DISARMED -> GsvColor.MutedDark
        }
    }

    Box(modifier.fillMaxSize().background(GsvColor.Void)) {
        LiveBackdrop(accent = accent, modifier = Modifier.fillMaxSize())
        AnimatedVisibility(
            visible = selected == GsvSurface.SHIP,
            enter = fadeIn(tween(520)),
            exit = fadeOut(tween(240)),
        ) {
            GsvStarField(modifier = Modifier.fillMaxSize())
        }
        AnimatedContent(
            targetState = selected,
            transitionSpec = { fadeIn(tween(230)) togetherWith fadeOut(tween(170)) },
            label = "gsv-surface",
        ) { destination ->
            when (destination) {
                GsvSurface.MIND -> MindSurface(
                    snapshot = assistantSnapshot,
                    gestureSnapshot = gestureSnapshot,
                    notice = uiState.runtimeNotice,
                    noticeIsError = uiState.runtimeError,
                    onToggle = onMindToggle,
                    onOpenSettings = { settingsVisible = true },
                    onSelect = { selectedIndex = it.ordinal },
                )
                GsvSurface.SHIP -> ShipSurface(
                    snapshot = wearSnapshot,
                    notice = uiState.runtimeNotice,
                    noticeIsError = uiState.runtimeError,
                    onToggle = {
                        if (wearSnapshot.authority == AuthorityState.DISARMED) onArm() else onDisarm()
                    },
                    onActivationStarted = onActivationStarted,
                    onOpenSettings = { settingsVisible = true },
                    onSelect = { selectedIndex = it.ordinal },
                )
            }
        }

        AnimatedVisibility(
            visible = settingsVisible,
            enter = fadeIn(tween(180)),
            exit = fadeOut(tween(150)),
        ) {
            SettingsSurface(
                wearSnapshot = wearSnapshot,
                assistantSnapshot = assistantSnapshot,
                uiState = uiState,
                onClose = { settingsVisible = false },
                onPauseOrResume = onPauseOrResume,
                onDisconnect = onDisconnect,
                onChooseAssistant = onChooseAssistant,
                onMindToggle = onMindToggle,
                onOpenBatterySettings = onOpenBatterySettings,
                onOpenNotificationSettings = onOpenNotificationSettings,
            )
        }
    }
}

@Composable
private fun MindSurface(
    snapshot: AssistantSnapshot,
    gestureSnapshot: GestureSnapshot,
    notice: String,
    noticeIsError: Boolean,
    onToggle: () -> Unit,
    onOpenSettings: () -> Unit,
    onSelect: (GsvSurface) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(horizontal = 20.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        LiveHeader(
            name = "MIND",
            connection = snapshot.connection,
            onOpenSettings = onOpenSettings,
        )
        Spacer(Modifier.weight(1f))
        MindCore(snapshot = snapshot, gestureSnapshot = gestureSnapshot, onToggle = onToggle)
        LiveNotice(
            text = notice,
            error = noticeIsError,
            modifier = Modifier.padding(top = 7.dp),
        )
        Spacer(Modifier.weight(1f))
        SurfaceNavigation(selected = GsvSurface.MIND, onSelect = onSelect)
    }
}

@Composable
private fun MindCore(
    snapshot: AssistantSnapshot,
    gestureSnapshot: GestureSnapshot,
    onToggle: () -> Unit,
) {
    val active = snapshot.turn != VoiceTurnState.IDLE
    val status = when {
        active -> snapshot.turn.stateLabel().uppercase()
        snapshot.connection == ConnectionState.CONNECTED -> "AVAILABLE"
        snapshot.connection == ConnectionState.OFFLINE -> "OFFLINE"
        snapshot.connection == ConnectionState.DISCONNECTED -> "DORMANT"
        else -> "LINKING"
    }
    val accent = when {
        active -> snapshot.turn.accentColor()
        snapshot.connection == ConnectionState.CONNECTED -> GsvColor.Accent
        snapshot.connection == ConnectionState.OFFLINE -> GsvColor.Amber
        else -> GsvColor.MutedDark
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) {
                contentDescription = "Mind conversation control"
                stateDescription = status
                role = Role.Button
            }
            .clickable(
                role = Role.Button,
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onToggle,
            ),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(350.dp), contentAlignment = Alignment.Center) {
            AssistantCore(
                state = snapshot.turn,
                signal = snapshot.level,
                modifier = Modifier.size(330.dp),
            )
            MindGestureFeedback(
                snapshot = gestureSnapshot,
                modifier = Modifier.fillMaxSize(),
            )
        }
        Text(
            text = status,
            style = GsvTextStyle.Kicker.copy(
                color = accent,
                fontSize = 9.sp,
                letterSpacing = 3.0.sp,
                textAlign = TextAlign.Center,
            ),
        )
        Spacer(Modifier.height(14.dp))
        Text(
            text = if (active) "TAP TO INTERRUPT" else "TAP TO SPEAK",
            style = GsvTextStyle.Kicker.copy(
                color = GsvColor.Muted,
                fontSize = 8.sp,
                letterSpacing = 2.0.sp,
                textAlign = TextAlign.Center,
            ),
        )
    }
}

@Composable
private fun MindGestureFeedback(
    snapshot: GestureSnapshot,
    modifier: Modifier = Modifier,
) {
    val progress by animateFloatAsState(
        targetValue = if (snapshot.state == GestureLinkState.TRACKING) snapshot.progress else 0f,
        animationSpec = tween(100, easing = FastOutSlowInEasing),
        label = "gesture-evidence",
    )
    val commit = remember { Animatable(0f) }
    LaunchedEffect(snapshot.commitSequence) {
        if (snapshot.commitSequence == 0L) return@LaunchedEffect
        commit.snapTo(1f)
        commit.animateTo(0f, tween(620, easing = FastOutSlowInEasing))
    }
    Canvas(modifier) {
        val stroke = 1.dp.toPx()
        if (progress > 0.01f) {
            drawArc(
                color = GsvColor.Accent.copy(alpha = 0.22f + progress * 0.62f),
                startAngle = -90f,
                sweepAngle = 360f * progress,
                useCenter = false,
                topLeft = Offset(stroke * 2f, stroke * 2f),
                size = Size(size.width - stroke * 4f, size.height - stroke * 4f),
                style = Stroke(width = stroke, cap = StrokeCap.Round),
            )
        }
        if (commit.value > 0.01f) {
            drawCircle(
                color = GsvColor.AccentBright.copy(alpha = commit.value * 0.55f),
                radius = size.minDimension * (0.46f + (1f - commit.value) * 0.05f),
                style = Stroke(width = stroke * (0.8f + commit.value)),
            )
        }
    }
}

@Composable
private fun ShipSurface(
    snapshot: RuntimeSnapshot,
    notice: String,
    noticeIsError: Boolean,
    onToggle: () -> Unit,
    onActivationStarted: () -> Unit,
    onOpenSettings: () -> Unit,
    onSelect: (GsvSurface) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(horizontal = 20.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        LiveHeader(
            name = "SHIP",
            connection = snapshot.connection,
            onOpenSettings = onOpenSettings,
        )
        Spacer(Modifier.weight(1f))
        ShipCore(
            authority = snapshot.authority,
            onToggleRequested = onToggle,
            onActivationStarted = onActivationStarted,
            modifier = Modifier.fillMaxWidth(),
        )
        LiveNotice(
            text = notice,
            error = noticeIsError,
            modifier = Modifier.padding(top = 5.dp),
        )
        if (snapshot.authority != AuthorityState.DISARMED) {
            Spacer(Modifier.height(13.dp))
            Text(
                text = "KEEP GSV FOREGROUNDED WHILE WORN",
                style = GsvTextStyle.Kicker.copy(
                    color = GsvColor.MutedDark,
                    fontSize = 7.sp,
                    letterSpacing = 1.5.sp,
                    textAlign = TextAlign.Center,
                ),
            )
        }
        Spacer(Modifier.weight(1f))
        SurfaceNavigation(selected = GsvSurface.SHIP, onSelect = onSelect)
    }
}

@Composable
private fun SurfaceNavigation(
    selected: GsvSurface,
    onSelect: (GsvSurface) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().height(58.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        GsvSurface.entries.forEachIndexed { index, destination ->
            SurfaceNavigationItem(
                destination = destination,
                selected = destination == selected,
                onClick = { onSelect(destination) },
            )
            if (index == 0) Spacer(Modifier.width(34.dp))
        }
    }
}

@Composable
private fun SurfaceNavigationItem(
    destination: GsvSurface,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .width(82.dp)
            .height(46.dp)
            .semantics { contentDescription = "Open ${destination.name.lowercase()}" }
            .clickable(
                role = Role.Tab,
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            ),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = destination.name,
            style = GsvTextStyle.Kicker.copy(
                color = if (selected) GsvColor.White else GsvColor.MutedDark,
                fontSize = 9.sp,
                letterSpacing = 2.4.sp,
            ),
        )
        Spacer(Modifier.height(8.dp))
        Box(
            Modifier
                .width(if (selected) 44.dp else 15.dp)
                .height(1.dp)
                .background(if (selected) GsvColor.Accent.copy(alpha = 0.74f) else GsvColor.Line),
        )
    }
}

@Composable
private fun LiveHeader(
    name: String,
    connection: ConnectionState,
    onOpenSettings: () -> Unit,
) {
    val connectionColor = connection.statusColor()
    Row(
        modifier = Modifier.fillMaxWidth().height(48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "GSV // $name",
            style = GsvTextStyle.Kicker.copy(
                color = GsvColor.White,
                fontSize = 11.sp,
                letterSpacing = 3.0.sp,
            ),
        )
        Spacer(Modifier.weight(1f))
        Canvas(Modifier.size(7.dp)) {
            drawCircle(connectionColor.copy(alpha = 0.22f), radius = size.minDimension)
            drawCircle(connectionColor, radius = size.minDimension * 0.42f)
        }
        Spacer(Modifier.width(8.dp))
        Text(
            text = connection.liveLabel(),
            style = GsvTextStyle.Kicker.copy(
                color = connectionColor,
                fontSize = 8.sp,
                letterSpacing = 1.7.sp,
            ),
        )
        Spacer(Modifier.width(11.dp))
        SettingsPortal(onClick = onOpenSettings)
    }
}

@Composable
private fun SettingsPortal(
    onClick: () -> Unit,
    close: Boolean = false,
) {
    Box(
        modifier = Modifier
            .size(42.dp)
            .semantics {
                contentDescription = if (close) "Close settings" else "Open settings"
            }
            .clickable(
                role = Role.Button,
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(25.dp)) {
            if (close) {
                val inset = 6.dp.toPx()
                drawLine(
                    color = GsvColor.Muted,
                    start = Offset(inset, inset),
                    end = Offset(size.width - inset, size.height - inset),
                    strokeWidth = 1.dp.toPx(),
                    cap = StrokeCap.Round,
                )
                drawLine(
                    color = GsvColor.Muted,
                    start = Offset(size.width - inset, inset),
                    end = Offset(inset, size.height - inset),
                    strokeWidth = 1.dp.toPx(),
                    cap = StrokeCap.Round,
                )
            } else {
                drawArc(
                    color = GsvColor.Muted.copy(alpha = 0.72f),
                    startAngle = 202f,
                    sweepAngle = 246f,
                    useCenter = false,
                    topLeft = Offset(3.dp.toPx(), 3.dp.toPx()),
                    size = Size(19.dp.toPx(), 19.dp.toPx()),
                    style = Stroke(0.8.dp.toPx(), cap = StrokeCap.Round),
                )
                repeat(3) { index ->
                    val angle = index / 3f * PI.toFloat() * 2f - PI.toFloat() / 2f
                    drawCircle(
                        color = if (index == 0) GsvColor.Accent else GsvColor.Muted,
                        radius = 1.6.dp.toPx(),
                        center = Offset(
                            center.x + cos(angle) * 7.dp.toPx(),
                            center.y + sin(angle) * 7.dp.toPx(),
                        ),
                    )
                }
            }
        }
    }
}

@Composable
private fun LiveNotice(text: String, error: Boolean, modifier: Modifier = Modifier) {
    AnimatedVisibility(visible = text.isNotBlank(), modifier = modifier) {
        Text(
            text = text,
            modifier = Modifier
                .fillMaxWidth()
                .semantics { liveRegion = LiveRegionMode.Polite }
                .padding(horizontal = 18.dp, vertical = 8.dp),
            style = GsvTextStyle.Body.copy(
                color = if (error) GsvColor.Red else GsvColor.Accent,
                fontSize = 11.sp,
                lineHeight = 16.sp,
                textAlign = TextAlign.Center,
            ),
        )
    }
}

@Composable
private fun SettingsSurface(
    wearSnapshot: RuntimeSnapshot,
    assistantSnapshot: AssistantSnapshot,
    uiState: ControlUiState,
    onClose: () -> Unit,
    onPauseOrResume: () -> Unit,
    onDisconnect: () -> Unit,
    onChooseAssistant: () -> Unit,
    onMindToggle: () -> Unit,
    onOpenBatterySettings: () -> Unit,
    onOpenNotificationSettings: () -> Unit,
) {
    val connectionDetail = buildString {
        append(wearSnapshot.connection.displayName())
        wearSnapshot.connectionFailure?.let { append(" // ${it.displayName()}") }
    }
    val mindActive = assistantSnapshot.turn != VoiceTurnState.IDLE
    Box(Modifier.fillMaxSize().background(GsvColor.Void)) {
        LiveBackdrop(accent = GsvColor.Accent, modifier = Modifier.fillMaxSize(), quiet = true)
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 22.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().height(66.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "SYSTEM",
                    style = GsvTextStyle.Kicker.copy(
                        color = GsvColor.White,
                        fontSize = 12.sp,
                        letterSpacing = 3.2.sp,
                    ),
                )
                Spacer(Modifier.weight(1f))
                SettingsPortal(onClick = onClose, close = true)
            }

            SettingsSection("Ship") {
                StatusReadout("Gateway", connectionDetail, color = wearSnapshot.connection.statusColor())
                Spacer(Modifier.height(12.dp))
                StatusReadout(
                    "Authority",
                    wearSnapshot.authority.displayName(),
                    color = when (wearSnapshot.authority) {
                        AuthorityState.ARMED -> GsvColor.Accent
                        AuthorityState.PAUSED -> GsvColor.Amber
                        AuthorityState.DISARMED -> GsvColor.MutedDark
                    },
                )
                Spacer(Modifier.height(12.dp))
                StatusReadout("Camera", wearSnapshot.camera.displayName(), color = wearSnapshot.camera.activityColor())
                Spacer(Modifier.height(12.dp))
                StatusReadout(
                    "Microphone",
                    wearSnapshot.microphone.displayName(),
                    color = wearSnapshot.microphone.activityColor(),
                )
                if (wearSnapshot.authority != AuthorityState.DISARMED) {
                    Spacer(Modifier.height(18.dp))
                    GsvButton(
                        label = if (wearSnapshot.authority == AuthorityState.PAUSED) "Resume Wear" else "Pause Wear",
                        onClick = onPauseOrResume,
                        modifier = Modifier.fillMaxWidth(),
                        tone = GsvButtonTone.SECONDARY,
                    )
                }
                Spacer(Modifier.height(10.dp))
                GsvButton(
                    label = "Disconnect Runtime",
                    onClick = onDisconnect,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = wearSnapshot.connection != ConnectionState.DISCONNECTED,
                    tone = GsvButtonTone.DANGER,
                )
            }

            SettingsSection("Mind") {
                StatusReadout(
                    "Private link",
                    assistantSnapshot.connection.displayName(),
                    color = assistantSnapshot.connection.statusColor(),
                )
                Spacer(Modifier.height(12.dp))
                StatusReadout(
                    "OS role",
                    if (uiState.assistantSelected) "Selected" else "Not selected",
                    color = if (uiState.assistantSelected) GsvColor.Accent else GsvColor.Amber,
                )
                Spacer(Modifier.height(18.dp))
                GsvButton(
                    label = if (uiState.assistantSelected) "GSV is Default Assistant" else "Make GSV Default Assistant",
                    onClick = onChooseAssistant,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !uiState.assistantSelected,
                    tone = GsvButtonTone.SECONDARY,
                )
                Spacer(Modifier.height(10.dp))
                GsvButton(
                    label = if (mindActive) "Interrupt Mind" else "Start Mind",
                    onClick = onMindToggle,
                    modifier = Modifier.fillMaxWidth(),
                    tone = GsvButtonTone.QUIET,
                )
            }

            SettingsSection("Access") {
                StatusReadout(
                    "Notifications",
                    uiState.notificationStatus,
                    color = if (uiState.notificationStatus == "Ready") GsvColor.Accent else GsvColor.Amber,
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
            }
            Spacer(Modifier.height(34.dp))
        }
    }
}

@Composable
private fun SettingsSection(
    title: String,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 22.dp, bottom = 12.dp),
    ) {
        Text(
            text = title.uppercase(),
            style = GsvTextStyle.Kicker.copy(color = GsvColor.Accent, fontSize = 9.sp),
        )
        Spacer(Modifier.height(12.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(
                    Brush.horizontalGradient(
                        listOf(GsvColor.Accent.copy(alpha = 0.34f), Color.Transparent),
                    ),
                ),
        )
        Spacer(Modifier.height(18.dp))
        content()
    }
}

@Composable
private fun LiveBackdrop(
    accent: Color,
    modifier: Modifier = Modifier,
    quiet: Boolean = false,
) {
    val phase = rememberVisualLoopFraction(24_000_000_000L) * PI.toFloat() * 2f
    Canvas(modifier) {
        drawRect(
            brush = Brush.verticalGradient(
                0f to Color(0xFF050414),
                0.48f to Color(0xFF0A0822),
                1f to Color(0xFF050414),
            ),
        )
        val intensity = if (quiet) 0.42f else 1f
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(
                    accent.copy(alpha = 0.105f * intensity),
                    accent.copy(alpha = 0.018f * intensity),
                    Color.Transparent,
                ),
                center = Offset(size.width * 0.56f, size.height * 0.43f),
                radius = size.minDimension * 0.78f,
            ),
            center = Offset(size.width * 0.56f, size.height * 0.43f),
            radius = size.minDimension * 0.78f,
        )
        repeat(4) { index ->
            val baseY = size.height * (0.21f + index * 0.17f)
            val motion = sin(phase + index * 1.41f) * size.height * 0.018f
            val path = Path().apply {
                moveTo(-size.width * 0.08f, baseY + motion)
                cubicTo(
                    size.width * 0.23f,
                    baseY - size.height * 0.075f + motion,
                    size.width * 0.64f,
                    baseY + size.height * 0.082f - motion,
                    size.width * 1.08f,
                    baseY - motion,
                )
            }
            drawPath(
                path = path,
                color = accent.copy(alpha = (0.025f - index * 0.003f) * intensity),
                style = Stroke((0.65f + index * 0.1f).dp.toPx(), cap = StrokeCap.Round),
            )
        }
        repeat(22) { index ->
            val x = ((index * 67 + 11) % 101) / 101f * size.width
            val baseY = ((index * 43 + 17) % 97) / 97f * size.height
            val y = baseY + sin(phase * (1f + index % 3) + index) * 5.dp.toPx()
            val pulse = 0.45f + 0.55f * sin(phase * 1.3f + index * 1.77f).coerceAtLeast(0f)
            drawCircle(
                color = if (index % 6 == 0) {
                    accent.copy(alpha = 0.12f * pulse * intensity)
                } else {
                    GsvColor.White.copy(alpha = 0.04f * pulse * intensity)
                },
                center = Offset(x, y),
                radius = if (index % 7 == 0) 0.9.dp.toPx() else 0.45.dp.toPx(),
            )
        }
        drawRect(
            brush = Brush.radialGradient(
                colors = listOf(Color.Transparent, GsvColor.Void.copy(alpha = 0.92f)),
                center = center,
                radius = size.maxDimension * 0.68f,
            ),
        )
    }
}

private fun Enum<*>.displayName(): String =
    name.lowercase().replace('_', ' ').replaceFirstChar(Char::uppercase)

private fun ConnectionState.liveLabel(): String = when (this) {
    ConnectionState.CONNECTED -> "LIVE"
    ConnectionState.CONNECTING,
    ConnectionState.RECONNECTING,
    -> "LINKING"
    ConnectionState.OFFLINE -> "OFFLINE"
    ConnectionState.DISCONNECTED -> "NO LINK"
}

private fun ConnectionState.statusColor(): Color = when (this) {
    ConnectionState.CONNECTED -> GsvColor.Accent
    ConnectionState.CONNECTING,
    ConnectionState.RECONNECTING,
    -> GsvColor.Blue
    ConnectionState.OFFLINE -> GsvColor.Amber
    ConnectionState.DISCONNECTED -> GsvColor.MutedDark
}

private fun Enum<*>.activityColor(): Color = when (name) {
    "ACTIVE" -> GsvColor.Accent
    "OPENING", "CLOSING" -> GsvColor.Blue
    else -> GsvColor.MutedDark
}
