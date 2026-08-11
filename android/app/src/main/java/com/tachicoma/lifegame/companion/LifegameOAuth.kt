package com.tachicoma.lifegame.companion

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.net.toUri
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

private const val OAUTH_SERVER = "https://lifegame.tachicoma.com"
private const val OAUTH_METADATA_URL = "$OAUTH_SERVER/.well-known/oauth-authorization-server"
const val LIFEGAME_REDIRECT_URI = "com.tachicoma.lifegame.companion:/oauth2redirect"

open class OAuthException(message: String) : Exception(message)

class OAuthInvalidClientException(message: String) : OAuthException(message)

enum class RefreshOutcome {
    REFRESHED,
    RECONNECT_REQUIRED,
    CLIENT_REGISTRATION_INVALID,
    NETWORK_FAILED,
}

private data class OAuthMetadata(
    val authorizationEndpoint: String,
    val tokenEndpoint: String,
    val registrationEndpoint: String,
)

private data class HttpResponse(
    val statusCode: Int,
    val body: String,
)

/** Pure DCR request construction; JSONObject does not turn Kotlin collections into arrays. */
internal fun oauthRegistrationRequestBody(redirectUri: String = LIFEGAME_REDIRECT_URI): String = JSONObject()
    .put("client_name", "lifegame Android companion")
    .put("application_type", "native")
    .put("redirect_uris", JSONArray().put(redirectUri))
    .put("response_types", JSONArray().put("code"))
    .put("grant_types", JSONArray().put("authorization_code").put("refresh_token"))
    .put("token_endpoint_auth_method", "none")
    .toString()

/** Cloudflare OAuth public-client flow used by the foreground sync button. */
class LifegameOAuthManager(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    // This is a sideloaded private app and allowBackup=false, so app-only SharedPreferences is
    // sufficient for the client id and OAuth tokens.
    fun hasAccessToken(): Boolean = accessToken() != null

    fun accessToken(): String? = preferences.getString(KEY_ACCESS_TOKEN, null)?.takeIf(String::isNotBlank)

    fun hasPendingAuthorization(): Boolean = pendingAuthorizationState() != null

    fun cancelPendingAuthorization() {
        preferences.edit().remove(KEY_PENDING_STATE).remove(KEY_PENDING_VERIFIER).apply()
    }

    fun resetRegistrationRecovery() {
        preferences.edit().remove(KEY_REGISTRATION_RECOVERY_ATTEMPTED).apply()
    }

    /** Returns true once per foreground sync attempt and invalidates the old DCR registration. */
    fun retryRegistrationAfterInvalidClient(): Boolean {
        if (preferences.getBoolean(KEY_REGISTRATION_RECOVERY_ATTEMPTED, false)) return false
        preferences.edit()
            .putBoolean(KEY_REGISTRATION_RECOVERY_ATTEMPTED, true)
            .remove(KEY_CLIENT_ID)
            .remove(KEY_ACCESS_TOKEN)
            .remove(KEY_REFRESH_TOKEN)
            .remove(KEY_PENDING_STATE)
            .remove(KEY_PENDING_VERIFIER)
            .apply()
        return true
    }

    suspend fun beginAuthorization(activity: Activity) {
        val metadata = withContext(Dispatchers.IO) { fetchMetadata() }
        val clientId = withContext(Dispatchers.IO) {
            preferences.getString(KEY_CLIENT_ID, null)?.takeIf(String::isNotBlank)
                ?: register(metadata).also { id -> preferences.edit().putString(KEY_CLIENT_ID, id).apply() }
        }
        val verifier = generateRandomString()
        val state = UUID.randomUUID().toString()
        preferences.edit()
            .putString(KEY_PENDING_STATE, state)
            .putString(KEY_PENDING_VERIFIER, verifier)
            .apply()

        val authorizationUrl = metadata.authorizationEndpoint.toUri().buildUpon()
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("client_id", clientId)
            .appendQueryParameter("redirect_uri", LIFEGAME_REDIRECT_URI)
            .appendQueryParameter("scope", "health:write")
            .appendQueryParameter("state", state)
            .appendQueryParameter("code_challenge", codeChallenge(verifier))
            .appendQueryParameter("code_challenge_method", "S256")
            .build()

        // Custom Tabs shares the browser's Cloudflare Access session. A WebView would stop at
        // Access login because it does not share that session.
        withContext(Dispatchers.Main.immediate) {
            CustomTabsIntent.Builder().build().launchUrl(activity, authorizationUrl)
        }
    }

    suspend fun completeAuthorization(intent: Intent) {
        val uri = intent.data ?: throw OAuthException("認証の戻り先を確認できませんでした。")
        val expectedState = preferences.getString(KEY_PENDING_STATE, null)
        val verifier = preferences.getString(KEY_PENDING_VERIFIER, null)
        val returnedState = uri.getQueryParameter("state")
        cancelPendingAuthorization()
        if (expectedState.isNullOrBlank() || verifier.isNullOrBlank() || returnedState != expectedState) {
            throw OAuthException("認証のstateを検証できませんでした。もう一度接続してください。")
        }
        uri.getQueryParameter("error")?.let { error ->
            val description = uri.getQueryParameter("error_description")
            if (error == "invalid_client") {
                throw OAuthInvalidClientException(description ?: "OAuth clientの登録が失効しています。")
            }
            throw OAuthException(description ?: "認証が許可されませんでした（$error）。")
        }
        val code = uri.getQueryParameter("code")?.takeIf(String::isNotBlank)
            ?: throw OAuthException("認証コードを受け取れませんでした。")
        val metadata = withContext(Dispatchers.IO) { fetchMetadata() }
        val clientId = preferences.getString(KEY_CLIENT_ID, null)?.takeIf(String::isNotBlank)
            ?: throw OAuthException("OAuth clientを登録できませんでした。")
        val response = withContext(Dispatchers.IO) {
            requestToken(
                metadata.tokenEndpoint,
                mapOf(
                    "grant_type" to "authorization_code",
                    "code" to code,
                    "redirect_uri" to LIFEGAME_REDIRECT_URI,
                    "client_id" to clientId,
                    "code_verifier" to verifier,
                ),
            )
        }
        if (response.isInvalidClient()) {
            clearTokens()
            throw OAuthInvalidClientException(errorMessage(response.body, response.statusCode))
        }
        if (response.statusCode !in 200..299) throw OAuthException(errorMessage(response.body, response.statusCode))
        saveTokenResponse(JSONObject(response.body), null)
    }

    suspend fun refreshAccessToken(): RefreshOutcome {
        val refreshToken = preferences.getString(KEY_REFRESH_TOKEN, null)?.takeIf(String::isNotBlank)
            ?: return RefreshOutcome.RECONNECT_REQUIRED
        val clientId = preferences.getString(KEY_CLIENT_ID, null)?.takeIf(String::isNotBlank)
            ?: return RefreshOutcome.RECONNECT_REQUIRED
        return try {
            val metadata = withContext(Dispatchers.IO) { fetchMetadata() }
            val response = withContext(Dispatchers.IO) {
                requestToken(
                    metadata.tokenEndpoint,
                    mapOf(
                        "grant_type" to "refresh_token",
                        "refresh_token" to refreshToken,
                        "client_id" to clientId,
                    ),
                )
            }
            if (response.isInvalidClient()) {
                clearTokens()
                RefreshOutcome.CLIENT_REGISTRATION_INVALID
            } else if (response.statusCode !in 200..299) {
                clearTokens()
                RefreshOutcome.RECONNECT_REQUIRED
            } else {
                saveTokenResponse(JSONObject(response.body), refreshToken)
                RefreshOutcome.REFRESHED
            }
        } catch (_: IOException) {
            RefreshOutcome.NETWORK_FAILED
        } catch (_: OAuthException) {
            RefreshOutcome.RECONNECT_REQUIRED
        } catch (_: Exception) {
            clearTokens()
            RefreshOutcome.RECONNECT_REQUIRED
        }
    }

    fun clearTokens() {
        preferences.edit()
            .remove(KEY_CLIENT_ID)
            .remove(KEY_ACCESS_TOKEN)
            .remove(KEY_REFRESH_TOKEN)
            .apply()
    }

    private fun fetchMetadata(): OAuthMetadata {
        val response = request("GET", OAUTH_METADATA_URL, null, null, null)
        if (response.statusCode !in 200..299) throw OAuthException(errorMessage(response.body, response.statusCode))
        val json = JSONObject(response.body)
        return OAuthMetadata(
            authorizationEndpoint = json.requiredString("authorization_endpoint"),
            tokenEndpoint = json.requiredString("token_endpoint"),
            registrationEndpoint = json.requiredString("registration_endpoint"),
        )
    }

    private fun register(metadata: OAuthMetadata): String {
        val response = request(
            method = "POST",
            url = metadata.registrationEndpoint,
            body = oauthRegistrationRequestBody(),
            contentType = "application/json",
            authorization = null,
        )
        if (response.statusCode !in 200..299) throw OAuthException(errorMessage(response.body, response.statusCode))
        return JSONObject(response.body).requiredString("client_id")
    }

    private fun requestToken(endpoint: String, parameters: Map<String, String>): HttpResponse {
        val body = parameters.entries.joinToString("&") { (key, value) ->
            "${urlEncode(key)}=${urlEncode(value)}"
        }
        return request("POST", endpoint, body, "application/x-www-form-urlencoded", null)
    }

    private fun saveTokenResponse(json: JSONObject, existingRefreshToken: String?) {
        val accessToken = json.optString("access_token").takeIf(String::isNotBlank)
            ?: throw OAuthException("access tokenを受け取れませんでした。")
        val refreshToken = json.optString("refresh_token").takeIf(String::isNotBlank) ?: existingRefreshToken
        val editor = preferences.edit().putString(KEY_ACCESS_TOKEN, accessToken)
        if (refreshToken != null) editor.putString(KEY_REFRESH_TOKEN, refreshToken)
        editor.apply()
    }

    private fun request(
        method: String,
        url: String,
        body: String?,
        contentType: String?,
        authorization: String?,
    ): HttpResponse {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 30_000
            doInput = true
            setRequestProperty("Accept", "application/json")
            contentType?.let { setRequestProperty("Content-Type", it) }
            authorization?.let { setRequestProperty("Authorization", "Bearer $it") }
        }
        return try {
            if (body != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            }
            val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
            val responseBody = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
            HttpResponse(connection.responseCode, responseBody)
        } finally {
            connection.disconnect()
        }
    }

    private fun JSONObject.requiredString(key: String): String = optString(key).takeIf(String::isNotBlank)
        ?: throw OAuthException("OAuth metadataの${key}がありません。")

    private fun errorMessage(body: String, statusCode: Int): String = runCatching {
        JSONObject(body).optString("error_description").takeIf(String::isNotBlank)
            ?: JSONObject(body).optString("error").takeIf(String::isNotBlank)
    }.getOrNull() ?: "OAuth通信に失敗しました（HTTP $statusCode）。"

    private fun HttpResponse.isInvalidClient(): Boolean = isInvalidClientResponse(statusCode, body)

    private fun pendingAuthorizationState(): Pair<String, String>? {
        val state = preferences.getString(KEY_PENDING_STATE, null)?.takeIf(String::isNotBlank) ?: return null
        val verifier = preferences.getString(KEY_PENDING_VERIFIER, null)?.takeIf(String::isNotBlank) ?: return null
        return state to verifier
    }

    private fun generateRandomString(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    private fun codeChallenge(verifier: String): String = Base64.getUrlEncoder().withoutPadding()
        .encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(StandardCharsets.US_ASCII)))

    private fun urlEncode(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8.name())

    private companion object {
        const val PREFERENCES_NAME = "lifegame.oauth"
        const val KEY_CLIENT_ID = "client_id"
        const val KEY_ACCESS_TOKEN = "access_token"
        const val KEY_REFRESH_TOKEN = "refresh_token"
        const val KEY_PENDING_STATE = "pending_state"
        const val KEY_PENDING_VERIFIER = "pending_verifier"
        const val KEY_REGISTRATION_RECOVERY_ATTEMPTED = "registration_recovery_attempted"
    }
}

internal fun isInvalidClientResponse(statusCode: Int, body: String): Boolean =
    statusCode in 400..401 && runCatching {
        JSONObject(body).optString("error") == "invalid_client"
    }.getOrDefault(false)
