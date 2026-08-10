package com.tachicoma.lifegame.companion

import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * 権限説明画面は Health Connect が権限ダイアログから直接開く画面で、ユーザーが
 * 許可を判断する唯一の説明でもある。HealthDataTest は PrivacyPolicy の定数だけを
 * 見ているので、定数が画面に届いているかはここで守る。
 *
 * 端末サイズは明示する。既定値のまま小さい画面を引くと、本文が伸びただけで
 * ボタンが画面外に出てテストが揺れる。
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class PermissionsRationaleScreenTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<PermissionsRationaleActivity>()

    @Test
    fun `the three summary points are actually rendered on the rationale screen`() {
        PrivacyPolicy.summary.forEach { point ->
            composeRule.onNodeWithText("・$point").performScrollTo().assertIsDisplayed()
        }
    }

    @Test
    fun `the full policy button opens the canonical url with ACTION_VIEW`() {
        composeRule
            .onNodeWithText("プライバシーポリシーの全文を開く")
            .performScrollTo()
            .performClick()

        val started = shadowOf(composeRule.activity).nextStartedActivity
        assertNotNull("全文ボタンが何も起動していない", started)
        assertEquals(Intent.ACTION_VIEW, started.action)
        assertEquals(PrivacyPolicy.URL, started.data.toString())
    }

    // openPrivacyPolicy() のフォールバック (Toast) は起動が拒まれた場合の分岐で、
    // 投げる intent 自体は seam を直接見るのが確実。
    @Test
    fun `the policy intent carries no extras and no explicit component`() {
        val intent = privacyPolicyIntent()

        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals(PrivacyPolicy.URL, intent.data.toString())
        assertEquals(null, intent.component)
        assertEquals(null, intent.extras)
    }
}
