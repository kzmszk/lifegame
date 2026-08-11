package com.tachicoma.lifegame.companion

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
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
}
