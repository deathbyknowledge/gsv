package com.humansandmachines.gsv.wear.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.humansandmachines.gsv.wear.authority.AuthorityState
import com.humansandmachines.gsv.wear.voice.VoiceTurnState
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GsvVisualSystemTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun disarmedWearCoreExposesItsAction() {
        var armRequested = false
        compose.setContent {
            Box {
                WearCore(
                    authority = AuthorityState.DISARMED,
                    onArmRequested = { armRequested = true },
                    onActivationStarted = {},
                    modifier = Modifier.size(270.dp),
                )
            }
        }

        compose.onNodeWithContentDescription("Wear Mode control")
            .assert(
                SemanticsMatcher.expectValue(
                    SemanticsProperties.StateDescription,
                    "WEAR MODE // STANDBY",
                ),
            )
            .performClick()
        compose.runOnIdle { assertTrue(armRequested) }
    }

    @Test
    fun assistantSurfaceAnnouncesThinkingState() {
        compose.setContent {
            AssistantSurface(
                state = VoiceTurnState.THINKING,
                detail = "Your personal agent has the floor.",
                onCancel = {},
            )
        }

        compose.onNodeWithContentDescription("GSV assistant agent is thinking").assertExists()
        compose.onNodeWithText("Agent is thinking").assertExists()
        compose.onNodeWithText("CANCEL").assertExists()
    }
}
