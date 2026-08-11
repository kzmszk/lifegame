package com.tachicoma.lifegame.companion

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.compose.runtime.MutableState
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class MainActivityAuthorizationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val oauthPreferences
        get() = context.getSharedPreferences("lifegame.oauth", Context.MODE_PRIVATE)

    @Before
    fun clearOAuthState() {
        oauthPreferences.edit().clear().commit()
    }

    @Test
    fun `callback delivered in recreated activity is handled from pending preferences`() {
        oauthPreferences.edit()
            .putString("pending_state", "state")
            .putString("pending_verifier", "verifier")
            .apply()

        val callback = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("com.tachicoma.lifegame.companion:/oauth2redirect?state=state&error=access_denied"),
        )
        Robolectric.buildActivity(MainActivity::class.java, callback).setup()
        shadowOf(Looper.getMainLooper()).idle()

        assertFalse(LifegameOAuthManager(context).hasPendingAuthorization())
    }

    @Test
    fun `back from browser clears the pending authorization and syncing state`() {
        val controller = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN)).setup()
        oauthPreferences.edit()
            .putString("pending_state", "state")
            .putString("pending_verifier", "verifier")
            .apply()

        controller.pause().resume()
        shadowOf(Looper.getMainLooper()).idle()

        assertFalse(LifegameOAuthManager(context).hasPendingAuthorization())
    }

    @Test
    fun `new intent callback is accepted without an in-memory waiting flag`() {
        val controller = Robolectric.buildActivity(MainActivity::class.java, Intent(Intent.ACTION_MAIN)).setup()
        oauthPreferences.edit()
            .putString("pending_state", "state")
            .putString("pending_verifier", "verifier")
            .apply()

        controller.newIntent(
            Intent(
                Intent.ACTION_VIEW,
                Uri.parse("com.tachicoma.lifegame.companion:/oauth2redirect?state=state&error=access_denied"),
            ),
        )
        shadowOf(Looper.getMainLooper()).idle()

        assertFalse(LifegameOAuthManager(context).hasPendingAuthorization())
    }

    @Test
    fun `after a callback a new authorization can still be cancelled`() {
        oauthPreferences.edit()
            .putString("pending_state", "first-state")
            .putString("pending_verifier", "first-verifier")
            .apply()
        val callback = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("com.tachicoma.lifegame.companion:/oauth2redirect?state=first-state&error=access_denied"),
        )
        val controller = Robolectric.buildActivity(MainActivity::class.java, callback).setup()
        shadowOf(Looper.getMainLooper()).idle()
        val activity = controller.get()

        assertFalse(activity.intent.data?.scheme == LIFEGAME_REDIRECT_URI.substringBefore(':'))

        oauthPreferences.edit()
            .putString("pending_state", "second-state")
            .putString("pending_verifier", "second-verifier")
            .apply()
        updateScreenState(activity) { copy(isSyncing = true, syncMessage = "ブラウザで許可してください。", syncErrorMessage = null) }

        controller.pause().resume()
        shadowOf(Looper.getMainLooper()).idle()

        val state = screenState(activity)
        assertFalse(state.isSyncing)
        assertEquals("接続がキャンセルされました。", state.syncErrorMessage)
        assertFalse(LifegameOAuthManager(context).hasPendingAuthorization())
    }

    @Suppress("UNCHECKED_CAST")
    private fun screenState(activity: MainActivity): HealthConnectScreenState {
        val field = MainActivity::class.java.getDeclaredField("screenState\$delegate")
        field.isAccessible = true
        return (field.get(activity) as MutableState<HealthConnectScreenState>).value
    }

    private fun updateScreenState(
        activity: MainActivity,
        update: HealthConnectScreenState.() -> HealthConnectScreenState,
    ) {
        val field = MainActivity::class.java.getDeclaredField("screenState\$delegate")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val state = field.get(activity) as MutableState<HealthConnectScreenState>
        state.value = state.value.update()
    }
}
