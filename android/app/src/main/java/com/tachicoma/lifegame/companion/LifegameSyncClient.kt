package com.tachicoma.lifegame.companion

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

class SyncApiException(
    val statusCode: Int,
    message: String,
) : Exception(message)

class SyncAuthenticationRequiredException(message: String) : Exception(message)

class SyncClientRegistrationInvalidException(message: String) : Exception(message)

class LifegameSyncClient(
    private val oauth: LifegameOAuthManager,
) {
    suspend fun post(body: String): Int {
        val token = oauth.accessToken()
            ?: throw SyncAuthenticationRequiredException("lifegameに接続してください。")
        val first = requestOnIo(token, body)
        if (first.statusCode != HttpURLConnection.HTTP_UNAUTHORIZED) {
            return acceptedOrThrow(first)
        }

        when (oauth.refreshAccessToken()) {
            RefreshOutcome.REFRESHED -> {
                val refreshedToken = oauth.accessToken()
                    ?: throw SyncAuthenticationRequiredException("再接続してください。")
                val retry = requestOnIo(refreshedToken, body)
                if (retry.statusCode == HttpURLConnection.HTTP_UNAUTHORIZED) {
                    oauth.clearTokens()
                    throw SyncAuthenticationRequiredException("lifegameとの接続が切れました。再接続してください。")
                }
                return acceptedOrThrow(retry)
            }

            RefreshOutcome.CLIENT_REGISTRATION_INVALID ->
                throw SyncClientRegistrationInvalidException("lifegameの接続登録が失効しました。再登録します。")

            RefreshOutcome.RECONNECT_REQUIRED ->
                throw SyncAuthenticationRequiredException("lifegameとの接続が切れました。再接続してください。")

            RefreshOutcome.NETWORK_FAILED ->
                throw SyncApiException(0, "ネットワークに接続できないため再認証できませんでした。")
        }
    }

    private suspend fun requestOnIo(token: String, body: String): RawResponse = try {
        withContext(Dispatchers.IO) { request(token, body) }
    } catch (_: IOException) {
        throw SyncApiException(0, "ネットワークに接続できませんでした。")
    }

    private fun request(token: String, body: String): RawResponse {
        val connection = (URL(SYNC_URL).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 30_000
            doInput = true
            doOutput = true
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Authorization", "Bearer $token")
        }
        return try {
            connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
            val responseBody = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
            RawResponse(connection.responseCode, responseBody)
        } finally {
            connection.disconnect()
        }
    }

    private fun acceptedOrThrow(response: RawResponse): Int {
        if (response.statusCode !in 200..299) {
            val serverMessage = runCatching { JSONObject(response.body).optString("error") }
                .getOrNull()
                ?.takeIf(String::isNotBlank)
            val message = when (response.statusCode) {
                HttpURLConnection.HTTP_BAD_REQUEST -> "同期データを受け付けませんでした。${serverMessage?.let { " $it" }.orEmpty()}"
                HttpURLConnection.HTTP_FORBIDDEN -> "health:write の権限がないため同期できません。${serverMessage?.let { " $it" }.orEmpty()}"
                HttpURLConnection.HTTP_ENTITY_TOO_LARGE -> "同期データが大きすぎます。${serverMessage?.let { " $it" }.orEmpty()}"
                else -> "lifegameへの同期に失敗しました（HTTP ${response.statusCode}）。${serverMessage?.let { " $it" }.orEmpty()}"
            }
            throw SyncApiException(response.statusCode, message)
        }
        return runCatching { JSONObject(response.body).getInt("accepted") }
            .getOrElse { throw SyncApiException(response.statusCode, "同期結果を解釈できませんでした。") }
    }

    private data class RawResponse(val statusCode: Int, val body: String)

    private companion object {
        const val SYNC_URL = "https://lifegame.tachicoma.com/sync"
    }
}
