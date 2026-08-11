package com.tachicoma.lifegame.companion

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp")
class LifegameOAuthTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Before
    fun clearPreferences() {
        context.getSharedPreferences("lifegame.oauth", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test
    fun `DCR metadata uses JSON arrays for list fields`() {
        val json = JSONObject(oauthRegistrationRequestBody("com.example:/cb"))

        assertEquals(listOf("com.example:/cb"), json.getJSONArray("redirect_uris").toStringList())
        assertEquals(listOf("code"), json.getJSONArray("response_types").toStringList())
        assertEquals(
            listOf("authorization_code", "refresh_token"),
            json.getJSONArray("grant_types").toStringList(),
        )
    }

    @Test
    fun `expired client registration is cleared and recovery is allowed only once`() {
        val preferences = context.getSharedPreferences("lifegame.oauth", Context.MODE_PRIVATE)
        preferences.edit()
            .putString("client_id", "expired-client")
            .putString("access_token", "access")
            .putString("refresh_token", "refresh")
            .apply()
        val manager = LifegameOAuthManager(context)

        assertTrue(manager.retryRegistrationAfterInvalidClient())
        assertNull(preferences.getString("client_id", null))
        assertNull(preferences.getString("access_token", null))
        assertNull(preferences.getString("refresh_token", null))
        assertFalse(manager.hasAccessToken())
        assertFalse(manager.retryRegistrationAfterInvalidClient())
    }

    @Test
    fun `invalid client from authorize is recoverable by one fresh registration`() = runBlocking {
        val preferences = context.getSharedPreferences("lifegame.oauth", Context.MODE_PRIVATE)
        preferences.edit()
            .putString("client_id", "expired-client")
            .putString("pending_state", "state")
            .putString("pending_verifier", "verifier")
            .apply()
        val callback = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("com.tachicoma.lifegame.companion:/oauth2redirect?state=state&error=invalid_client"),
        )

        var thrown = false
        try {
            LifegameOAuthManager(context).completeAuthorization(callback)
        } catch (_: OAuthInvalidClientException) {
            thrown = true
        }

        assertTrue(thrown)
        assertFalse(LifegameOAuthManager(context).hasPendingAuthorization())
        assertTrue(LifegameOAuthManager(context).retryRegistrationAfterInvalidClient())
        assertFalse(LifegameOAuthManager(context).retryRegistrationAfterInvalidClient())
    }

    @Test
    fun `only token 400 and 401 invalid client responses trigger registration recovery`() {
        val body = "{\"error\":\"invalid_client\"}"

        assertTrue(isInvalidClientResponse(400, body))
        assertTrue(isInvalidClientResponse(401, body))
        assertFalse(isInvalidClientResponse(200, body))
        assertFalse(isInvalidClientResponse(422, body))
        assertFalse(isInvalidClientResponse(401, "{\"error\":\"invalid_grant\"}"))
    }

    @Test
    fun `clearTokens also discards the client id`() {
        val preferences = context.getSharedPreferences("lifegame.oauth", Context.MODE_PRIVATE)
        preferences.edit().putString("client_id", "expired-client").apply()

        LifegameOAuthManager(context).clearTokens()

        assertNull(preferences.getString("client_id", null))
    }

    private fun org.json.JSONArray.toStringList(): List<String> = buildList {
        for (index in 0 until length()) add(getString(index))
    }
}
