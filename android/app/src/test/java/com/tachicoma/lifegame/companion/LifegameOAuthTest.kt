package com.tachicoma.lifegame.companion

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.ArrayDeque
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
    fun `registration is reused before six day safety window and replaced at the window`() = runBlocking {
        val preferences = context.getSharedPreferences("lifegame.oauth", Context.MODE_PRIVATE)
        val registeredAt = Instant.parse("2026-08-01T00:00:00Z")
        val firstClient = FakeOAuthHttpClient(metadataResponse(), registrationResponse("client-1"))

        LifegameOAuthManager(context, fixedClock(registeredAt), firstClient).beginAuthorization(RecordingActivity())

        assertEquals("client-1", preferences.getString("client_id", null))
        assertEquals(registeredAt.toEpochMilli(), preferences.getLong("client_registered_at", -1L))

        val reusedClient = FakeOAuthHttpClient(metadataResponse())
        LifegameOAuthManager(
            context,
            fixedClock(registeredAt.plus(Duration.ofDays(5))),
            reusedClient,
        ).beginAuthorization(RecordingActivity())

        assertEquals(1, reusedClient.calls.size)
        assertEquals("client-1", preferences.getString("client_id", null))

        val expiredClient = FakeOAuthHttpClient(metadataResponse(), registrationResponse("client-2"))
        LifegameOAuthManager(
            context,
            fixedClock(registeredAt.plus(Duration.ofDays(OAUTH_CLIENT_REGISTRATION_MAX_AGE_DAYS))),
            expiredClient,
        ).beginAuthorization(RecordingActivity())

        assertEquals(2, expiredClient.calls.size)
        assertEquals("client-2", preferences.getString("client_id", null))
    }

    @Test
    fun `successful token exchange refreshes the registration timestamp`() = runBlocking {
        val registeredAt = Instant.parse("2026-08-01T00:00:00Z")
        val exchangedAt = registeredAt.plus(Duration.ofDays(5))
        val registrationClient = FakeOAuthHttpClient(metadataResponse(), registrationResponse("client-1"))
        LifegameOAuthManager(context, fixedClock(registeredAt), registrationClient)
            .beginAuthorization(RecordingActivity())

        val preferences = context.getSharedPreferences("lifegame.oauth", Context.MODE_PRIVATE)
        val state = checkNotNull(preferences.getString("pending_state", null))
        val tokenClient = FakeOAuthHttpClient(
            metadataResponse(),
            OAuthHttpResponse(200, "{\"access_token\":\"access\",\"refresh_token\":\"refresh\"}"),
        )
        val callback = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("$LIFEGAME_REDIRECT_URI?state=$state&code=authorization-code"),
        )

        LifegameOAuthManager(context, fixedClock(exchangedAt), tokenClient).completeAuthorization(callback)

        assertEquals(exchangedAt.toEpochMilli(), preferences.getLong("client_registered_at", -1L))
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

    private fun fixedClock(now: Instant): Clock = Clock.fixed(now, ZoneOffset.UTC)

    private fun metadataResponse(): OAuthHttpResponse = OAuthHttpResponse(
        200,
        """
            {
              "authorization_endpoint":"https://example.test/authorize",
              "token_endpoint":"https://example.test/token",
              "registration_endpoint":"https://example.test/register"
            }
        """.trimIndent(),
    )

    private fun registrationResponse(clientId: String): OAuthHttpResponse =
        OAuthHttpResponse(201, "{\"client_id\":\"$clientId\"}")

    private class FakeOAuthHttpClient(vararg responses: OAuthHttpResponse) : OAuthHttpClient {
        private val responseQueue = ArrayDeque<OAuthHttpResponse>().apply { responses.forEach { addLast(it) } }
        val calls = mutableListOf<String>()

        override fun request(
            method: String,
            url: String,
            body: String?,
            contentType: String?,
            authorization: String?,
        ): OAuthHttpResponse {
            calls += "$method $url"
            return checkNotNull(responseQueue.pollFirst()) { "No fake response for $method $url" }
        }
    }

    // CustomTabsIntent.launchUrl goes through ContextCompat, which calls the two-argument
    // overload. Stubbing only the one-argument one lets the real Activity implementation run
    // and it dies on a null main thread, which reads as a failure of the code under test.
    private class RecordingActivity : Activity() {
        override fun startActivity(intent: Intent) = Unit

        override fun startActivity(intent: Intent, options: Bundle?) = Unit
    }
}
