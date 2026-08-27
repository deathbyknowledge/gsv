package com.humansandmachines.gsv.wear.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CutCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.BasicText as Text
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt

object GsvColor {
    val Void = Color(0xFF05080A)
    val Deep = Color(0xFF071116)
    val Panel = Color(0xE60B171D)
    val Line = Color(0xFF24404A)
    val LineSoft = Color(0x552B6672)
    val Cyan = Color(0xFF66F3FF)
    val CyanBright = Color(0xFFB8FBFF)
    val Blue = Color(0xFF6888FF)
    val Violet = Color(0xFF9C7CFF)
    val Amber = Color(0xFFFFC66D)
    val Red = Color(0xFFFF6B7A)
    val White = Color(0xFFF1F8FA)
    val Muted = Color(0xFF8AA1AA)
    val MutedDark = Color(0xFF52666E)
}

object GsvTextStyle {
    val Kicker = TextStyle(
        color = GsvColor.Cyan,
        fontFamily = FontFamily.Monospace,
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 2.2.sp,
    )
    val Hero = TextStyle(
        color = GsvColor.White,
        fontFamily = FontFamily.SansSerif,
        fontSize = 32.sp,
        lineHeight = 35.sp,
        fontWeight = FontWeight.Light,
        letterSpacing = (-0.4).sp,
    )
    val Title = TextStyle(
        color = GsvColor.White,
        fontFamily = FontFamily.SansSerif,
        fontSize = 20.sp,
        lineHeight = 25.sp,
        fontWeight = FontWeight.Medium,
    )
    val Body = TextStyle(
        color = GsvColor.Muted,
        fontFamily = FontFamily.SansSerif,
        fontSize = 14.sp,
        lineHeight = 21.sp,
        fontWeight = FontWeight.Normal,
    )
    val Data = TextStyle(
        color = GsvColor.White,
        fontFamily = FontFamily.Monospace,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        fontWeight = FontWeight.Normal,
        letterSpacing = 0.3.sp,
    )
    val Button = TextStyle(
        color = GsvColor.White,
        fontFamily = FontFamily.Monospace,
        fontSize = 12.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.5.sp,
    )
}

@Composable
fun SignalBackdrop(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "signal-field")
    val scan by transition.animateFloat(
        initialValue = -0.15f,
        targetValue = 1.15f,
        animationSpec = infiniteRepeatable(tween(7_000, easing = LinearEasing)),
        label = "scan",
    )
    Canvas(modifier.fillMaxSize()) {
        drawRect(
            brush = Brush.verticalGradient(
                listOf(GsvColor.Void, GsvColor.Deep, GsvColor.Void),
            ),
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(Color(0x26235E72), Color.Transparent),
                center = center.copy(y = size.height * 0.22f),
                radius = size.maxDimension * 0.7f,
            ),
            radius = size.maxDimension * 0.7f,
            center = center.copy(y = size.height * 0.22f),
        )

        val grid = 32.dp.toPx()
        var x = 0f
        while (x <= size.width) {
            drawLine(GsvColor.LineSoft, start = androidx.compose.ui.geometry.Offset(x, 0f), end = androidx.compose.ui.geometry.Offset(x, size.height), strokeWidth = 0.5.dp.toPx())
            x += grid
        }
        var y = 0f
        while (y <= size.height) {
            drawLine(GsvColor.LineSoft, start = androidx.compose.ui.geometry.Offset(0f, y), end = androidx.compose.ui.geometry.Offset(size.width, y), strokeWidth = 0.5.dp.toPx())
            y += grid
        }

        val scanY = size.height * scan
        drawRect(
            brush = Brush.verticalGradient(
                listOf(Color.Transparent, Color(0x2466F3FF), Color.Transparent),
                startY = scanY - 36.dp.toPx(),
                endY = scanY + 36.dp.toPx(),
            ),
            topLeft = androidx.compose.ui.geometry.Offset(0f, scanY - 36.dp.toPx()),
            size = androidx.compose.ui.geometry.Size(size.width, 72.dp.toPx()),
        )
    }
}

enum class GsvButtonTone {
    PRIMARY,
    SECONDARY,
    DANGER,
    QUIET,
}

@Composable
fun GsvButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    tone: GsvButtonTone = GsvButtonTone.SECONDARY,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed && enabled) 0.975f else 1f,
        animationSpec = tween(90),
        label = "command-press",
    )
    val accent = when (tone) {
        GsvButtonTone.PRIMARY -> GsvColor.Cyan
        GsvButtonTone.DANGER -> GsvColor.Red
        GsvButtonTone.QUIET -> GsvColor.MutedDark
        GsvButtonTone.SECONDARY -> GsvColor.Blue
    }
    val background = when (tone) {
        GsvButtonTone.PRIMARY -> Color(0x293DF2FF)
        GsvButtonTone.DANGER -> Color(0x24FF6B7A)
        GsvButtonTone.QUIET -> Color(0x12000000)
        GsvButtonTone.SECONDARY -> Color(0x1F6888FF)
    }
    val alpha = if (enabled) 1f else 0.38f
    val shape = CutCornerShape(topStart = 2.dp, topEnd = 12.dp, bottomEnd = 2.dp, bottomStart = 12.dp)

    Box(
        modifier = modifier
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
                this.alpha = alpha
            }
            .clip(shape)
            .background(background)
            .border(1.dp, accent.copy(alpha = 0.72f), shape)
            .clickable(
                enabled = enabled,
                role = Role.Button,
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .defaultMinSize(minHeight = 56.dp)
            .padding(horizontal = 20.dp, vertical = 15.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label.uppercase(),
            style = GsvTextStyle.Button.copy(color = if (tone == GsvButtonTone.PRIMARY) GsvColor.CyanBright else GsvColor.White),
        )
    }
}

@Composable
fun GsvField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    secret: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = CutCornerShape(topStart = 2.dp, topEnd = 10.dp, bottomEnd = 2.dp, bottomStart = 10.dp)
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(label.uppercase(), style = GsvTextStyle.Kicker.copy(color = if (focused) GsvColor.Cyan else GsvColor.Muted))
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            enabled = true,
            singleLine = true,
            maxLines = 1,
            textStyle = GsvTextStyle.Data,
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
            visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
            cursorBrush = SolidColor(GsvColor.Cyan),
            interactionSource = interaction,
            decorationBox = { inner ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 54.dp)
                        .clip(shape)
                        .background(GsvColor.Panel)
                        .border(
                            1.dp,
                            if (focused) GsvColor.Cyan.copy(alpha = 0.9f) else GsvColor.Line,
                            shape,
                        )
                        .padding(horizontal = 16.dp, vertical = 15.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (value.isEmpty() && placeholder.isNotEmpty()) {
                        Text(placeholder, style = GsvTextStyle.Data.copy(color = GsvColor.MutedDark))
                    }
                    inner()
                }
            },
        )
    }
}

@Composable
fun GsvSectionHeader(
    index: String,
    title: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onToggle)
            .padding(vertical = 17.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(index, style = GsvTextStyle.Kicker.copy(color = GsvColor.MutedDark))
        Spacer(Modifier.width(14.dp))
        Text(title.uppercase(), style = GsvTextStyle.Button, modifier = Modifier.weight(1f))
        Text(if (expanded) "−" else "+", style = GsvTextStyle.Title.copy(color = GsvColor.Cyan))
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(GsvColor.LineSoft))
}

@Composable
fun StatusReadout(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    color: Color = GsvColor.Cyan,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(6.dp)
                .background(color, CutCornerShape(1.dp)),
        )
        Spacer(Modifier.width(10.dp))
        Text(label.uppercase(), style = GsvTextStyle.Kicker.copy(color = GsvColor.Muted), modifier = Modifier.weight(1f))
        Text(value.uppercase(), style = GsvTextStyle.Data.copy(color = color))
    }
}

@Composable
fun InlineNotice(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = GsvColor.Cyan,
) {
    if (text.isBlank()) return
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(color.copy(alpha = 0.08f), CutCornerShape(topEnd = 8.dp, bottomStart = 8.dp))
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("//", style = GsvTextStyle.Kicker.copy(color = color))
        Spacer(Modifier.width(10.dp))
        Text(text, style = GsvTextStyle.Body.copy(color = GsvColor.White), modifier = Modifier.weight(1f))
    }
}

fun Float.percentLabel(): String = "${(coerceIn(0f, 1f) * 100).roundToInt().toString().padStart(3, '0')}%"
