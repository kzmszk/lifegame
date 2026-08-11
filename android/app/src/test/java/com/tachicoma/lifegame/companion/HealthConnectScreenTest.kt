package com.tachicoma.lifegame.companion

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * 同期の失敗は、押したボタンのそばに出ていないと気づけない。実機で機内モードにして
 * 試したとき、エラーは画面いちばん上の Health Connect カードに出ていて、ボタンからは
 * 1000px 以上離れていた。押した人には何も起きていないように見える。
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class HealthConnectScreenTest {
    @get:Rule
    val composeRule = createComposeRule()

    private val state = HealthConnectScreenState(
        availability = HealthConnectAvailability.AVAILABLE,
        grantedPermissions = HealthPermissions.all,
        syncErrorMessage = "ネットワークに接続できませんでした。",
    )

    @Test
    fun `a sync failure is reported next to the sync button, not at the top of the page`() {
        composeRule.setContent {
            HealthConnectScreen(
                state = state,
                onRequestPermissions = {},
                onRefresh = {},
                onSyncNow = {},
                onOpenSettings = {},
                onOpenPrivacyPolicy = {},
            )
        }

        composeRule.onNodeWithText(state.syncErrorMessage!!).performScrollTo().assertIsDisplayed()

        val button = composeRule.onNodeWithText("今すぐ同期").fetchSemanticsNode().positionInRoot.y
        val error = composeRule.onNodeWithText(state.syncErrorMessage!!).fetchSemanticsNode().positionInRoot.y
        assertTrue("同期エラーが同期ボタンより上に出ている", error > button)
    }
}
