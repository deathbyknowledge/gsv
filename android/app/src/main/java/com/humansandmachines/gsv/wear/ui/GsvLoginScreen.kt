package com.humansandmachines.gsv.wear.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText as Text
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.humansandmachines.gsv.wear.config.ConnectionFields
import com.humansandmachines.gsv.wear.config.OnboardingInput
import com.humansandmachines.gsv.wear.voice.VoiceTurnState

data class OnboardingUiState(
    val connecting: Boolean = false,
    val notice: String = "",
    val error: Boolean = false,
)

private enum class LoginStep {
    GATEWAY,
    USERNAME,
    PASSWORD,
}

@Composable
fun GsvLoginScreen(
    initialFields: ConnectionFields?,
    uiState: OnboardingUiState,
    allowCleartext: Boolean,
    onLogin: (gatewayUrl: String, username: String, password: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val initialAddress = initialFields?.gatewayUrl?.let(OnboardingInput::addressFromGatewayUrl)
    val initialStep = when {
        initialAddress.isNullOrBlank() -> LoginStep.GATEWAY
        initialFields.username.isBlank() -> LoginStep.USERNAME
        else -> LoginStep.PASSWORD
    }
    var step by rememberSaveable { mutableStateOf(initialStep) }
    var gatewayAddress by rememberSaveable { mutableStateOf(initialAddress.orEmpty()) }
    var username by rememberSaveable { mutableStateOf(initialFields?.username.orEmpty()) }
    var password by remember { mutableStateOf("") }
    var localNotice by rememberSaveable { mutableStateOf("") }

    fun goBack() {
        localNotice = ""
        when (step) {
            LoginStep.GATEWAY -> Unit
            LoginStep.USERNAME -> step = LoginStep.GATEWAY
            LoginStep.PASSWORD -> {
                password = ""
                step = LoginStep.USERNAME
            }
        }
    }

    BackHandler(enabled = step != LoginStep.GATEWAY && !uiState.connecting, onBack = ::goBack)

    Box(modifier.fillMaxSize().background(GsvColor.Void)) {
        SignalBackdrop()
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(horizontal = 24.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("GSV // SECURE LINK", style = GsvTextStyle.Kicker)
                    Spacer(Modifier.height(6.dp))
                    Text("Sign in", style = GsvTextStyle.Hero)
                }
                Text(
                    text = "0${step.ordinal + 1} / 03",
                    style = GsvTextStyle.Data.copy(color = GsvColor.MutedDark),
                )
            }

            Spacer(Modifier.height(24.dp))
            AssistantCore(
                state = if (uiState.connecting) VoiceTurnState.PREPARING else VoiceTurnState.IDLE,
                modifier = Modifier.size(178.dp),
            )
            Spacer(Modifier.height(18.dp))
            Text(
                text = when (step) {
                    LoginStep.GATEWAY -> "Where is your GSV?"
                    LoginStep.USERNAME -> "Which account is yours?"
                    LoginStep.PASSWORD -> "Authorize this phone"
                },
                style = GsvTextStyle.Title.copy(textAlign = TextAlign.Center),
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = when (step) {
                    LoginStep.GATEWAY -> "Enter the address you use to reach your GSV."
                    LoginStep.USERNAME -> "Use the same username you use on Desktop and the web."
                    LoginStep.PASSWORD -> "GSV will create this phone's driver and assistant links automatically."
                },
                style = GsvTextStyle.Body.copy(textAlign = TextAlign.Center),
            )

            Spacer(Modifier.height(26.dp))
            when (step) {
                LoginStep.GATEWAY -> GsvField(
                    label = "GSV address",
                    value = gatewayAddress,
                    onValueChange = {
                        gatewayAddress = it
                        localNotice = ""
                    },
                    placeholder = "mine.gsv.space",
                    enabled = !uiState.connecting,
                    keyboardType = KeyboardType.Uri,
                )
                LoginStep.USERNAME -> GsvField(
                    label = "Username",
                    value = username,
                    onValueChange = {
                        username = it
                        localNotice = ""
                    },
                    enabled = !uiState.connecting,
                    keyboardType = KeyboardType.Text,
                )
                LoginStep.PASSWORD -> GsvField(
                    label = "GSV password",
                    value = password,
                    onValueChange = {
                        password = it
                        localNotice = ""
                    },
                    placeholder = "Password",
                    secret = true,
                    enabled = !uiState.connecting,
                    keyboardType = KeyboardType.Password,
                )
            }

            InlineNotice(
                text = localNotice.ifBlank { uiState.notice },
                modifier = Modifier.padding(top = 14.dp).semantics { liveRegion = LiveRegionMode.Polite },
                color = if (localNotice.isNotBlank() || uiState.error) GsvColor.Red else GsvColor.Cyan,
            )
            Spacer(Modifier.height(18.dp))
            GsvButton(
                label = when {
                    uiState.connecting -> "Establishing secure link…"
                    step == LoginStep.PASSWORD -> "Sign in & enroll phone"
                    else -> "Continue"
                },
                onClick = {
                    when (step) {
                        LoginStep.GATEWAY -> {
                            localNotice = OnboardingInput.addressError(gatewayAddress).orEmpty()
                            if (localNotice.isEmpty()) step = LoginStep.USERNAME
                        }
                        LoginStep.USERNAME -> {
                            localNotice = OnboardingInput.usernameError(username).orEmpty()
                            if (localNotice.isEmpty()) step = LoginStep.PASSWORD
                        }
                        LoginStep.PASSWORD -> {
                            localNotice = OnboardingInput.passwordError(password).orEmpty()
                            if (localNotice.isEmpty()) {
                                val submittedPassword = password
                                password = ""
                                onLogin(
                                    OnboardingInput.gatewayUrl(gatewayAddress, allowCleartext),
                                    username.trim(),
                                    submittedPassword,
                                )
                            }
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !uiState.connecting,
                tone = GsvButtonTone.PRIMARY,
            )
            if (step != LoginStep.GATEWAY) {
                Spacer(Modifier.height(10.dp))
                GsvButton(
                    label = "Back",
                    onClick = ::goBack,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !uiState.connecting,
                    tone = GsvButtonTone.QUIET,
                )
            }
            Spacer(Modifier.height(28.dp))
            Text(
                text = "PASSWORD USED ONCE // NEVER STORED // CREDENTIALS DEVICE-BOUND",
                style = GsvTextStyle.Kicker.copy(
                    color = GsvColor.MutedDark,
                    textAlign = TextAlign.Center,
                ),
            )
        }
    }
}
