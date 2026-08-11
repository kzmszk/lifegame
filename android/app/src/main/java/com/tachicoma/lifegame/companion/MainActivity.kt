package com.tachicoma.lifegame.companion

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.lifecycleScope
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private var screenState by mutableStateOf(HealthConnectScreenState())
    private val oauthManager by lazy { LifegameOAuthManager(applicationContext) }
    private val syncTokenStore by lazy { HealthSyncTokenStore(applicationContext) }
    private val syncResultStore by lazy { HealthSyncResultStore(applicationContext) }
    private var authorizationCallbackReceived = false

    private val permissionLauncher = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
    ) {
        refresh()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (oauthManager.hasPendingAuthorization()) {
            screenState = screenState.copy(
                isSyncing = true,
                syncMessage = "ブラウザでlifegameへの接続を許可してください。",
            )
        }
        syncResultStore.load()?.let { result ->
            screenState = screenState.copy(lastSyncedAt = result.completedAt, lastSyncResult = result)
        }
        setContent {
            LifegameCompanionTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    HealthConnectScreen(
                        state = screenState,
                        onRequestPermissions = {
                            val missing = HealthPermissions.all - screenState.grantedPermissions
                            if (missing.isNotEmpty()) permissionLauncher.launch(missing)
                        },
                        onRefresh = ::refresh,
                        onSyncNow = ::syncNow,
                        onOpenSettings = ::openHealthConnectSettings,
                        onOpenPrivacyPolicy = { openPrivacyPolicy() },
                    )
                }
            }
        }
        if (intent.isLifegameOAuthCallback()) {
            authorizationCallbackReceived = true
            handleAuthorizationCallback(intent)
        } else {
            refresh()
        }
    }

    override fun onResume() {
        super.onResume()
        if (
            !intent.isLifegameOAuthCallback() &&
            oauthManager.hasPendingAuthorization() &&
            !authorizationCallbackReceived
        ) {
            oauthManager.cancelPendingAuthorization()
            screenState = screenState.copy(
                isSyncing = false,
                syncMessage = null,
                syncErrorMessage = "接続がキャンセルされました。",
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (!intent.isLifegameOAuthCallback()) return
        authorizationCallbackReceived = true
        handleAuthorizationCallback(intent)
    }

    private fun handleAuthorizationCallback(intent: Intent) {
        // A callback intent is a one-shot delivery mechanism. Keeping it on the Activity makes
        // the next browser cancellation look like another callback forever.
        setIntent(Intent(this, MainActivity::class.java))
        if (!oauthManager.hasPendingAuthorization()) {
            authorizationCallbackReceived = false
            return
        }
        screenState = screenState.copy(syncMessage = "lifegameとの接続を確認しています…")
        lifecycleScope.launch {
            try {
                oauthManager.completeAuthorization(intent)
                syncNowWithToken()
            } catch (error: OAuthInvalidClientException) {
                if (restartAuthorizationAfterInvalidClient()) return@launch
                showSyncError(error, "lifegameとの接続に失敗しました。")
            } catch (error: SyncClientRegistrationInvalidException) {
                if (restartAuthorizationAfterInvalidClient()) return@launch
                showSyncError(error, "lifegameとの接続に失敗しました。")
            } catch (error: Exception) {
                showSyncError(error, "lifegameとの接続に失敗しました。")
            } finally {
                authorizationCallbackReceived = false
            }
        }
    }

    private fun refresh() {
        if (screenState.isRefreshing) return
        screenState = screenState.copy(isRefreshing = true, errorMessage = null)
        lifecycleScope.launch {
            val availability = HealthConnectClient.getSdkStatus(this@MainActivity)
            when (availability) {
                HealthConnectClient.SDK_AVAILABLE -> {
                    try {
                        val client = HealthConnectClient.getOrCreate(this@MainActivity)
                        val result = HealthConnectReader(client).read()
                        screenState = screenState.copy(
                            availability = HealthConnectAvailability.AVAILABLE,
                            grantedPermissions = result.grantedPermissions,
                            summaries = result.summaries,
                            isRefreshing = false,
                            errorMessage = null,
                        )
                    } catch (_: Exception) {
                        screenState = screenState.copy(
                            availability = HealthConnectAvailability.AVAILABLE,
                            isRefreshing = false,
                            errorMessage = "Health Connectの状態を確認できませんでした。もう一度試してください。",
                        )
                    }
                }

                HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                    screenState = screenState.copy(
                        availability = HealthConnectAvailability.PROVIDER_UPDATE_REQUIRED,
                        isRefreshing = false,
                    )
                }

                else -> {
                    screenState = screenState.copy(
                        availability = HealthConnectAvailability.UNAVAILABLE,
                        isRefreshing = false,
                    )
                }
            }
        }
    }

    private fun syncNow() {
        if (screenState.isSyncing || screenState.isRefreshing) return
        oauthManager.resetRegistrationRecovery()
        authorizationCallbackReceived = false
        screenState = screenState.copy(
            isSyncing = true,
            syncMessage = "lifegameとの接続を確認しています…",
            syncErrorMessage = null,
        )
        lifecycleScope.launch {
            try {
                if (!oauthManager.hasAccessToken()) {
                    oauthManager.beginAuthorization(this@MainActivity)
                    screenState = screenState.copy(syncMessage = "ブラウザでlifegameへの接続を許可してください。")
                } else {
                    syncNowWithToken()
                }
            } catch (error: SyncClientRegistrationInvalidException) {
                if (restartAuthorizationAfterInvalidClient()) return@launch
                showSyncError(error, "同期に失敗しました。")
            } catch (error: Exception) {
                showSyncError(error, "同期に失敗しました。")
            }
        }
    }

    private suspend fun restartAuthorizationAfterInvalidClient(): Boolean {
        if (!oauthManager.retryRegistrationAfterInvalidClient()) return false
        try {
            oauthManager.beginAuthorization(this@MainActivity)
        } catch (error: Exception) {
            showSyncError(error, "再登録に失敗しました。")
            return true
        }
        screenState = screenState.copy(
            isSyncing = true,
            syncMessage = "接続登録を更新しました。ブラウザで再度許可してください。",
            syncErrorMessage = null,
        )
        return true
    }

    private fun showSyncError(error: Exception, fallback: String) {
        screenState = screenState.copy(
            isSyncing = false,
            syncMessage = null,
            syncErrorMessage = error.userMessage(fallback),
        )
    }

    private suspend fun syncNowWithToken() {
        screenState = screenState.copy(syncMessage = "Health Connectから同期対象を読み取っています…")
        val client = HealthConnectClient.getOrCreate(this@MainActivity)
        val readResult = HealthConnectReader(client).readChanges(syncTokenStore)
        val payload = HealthSyncPayloadBuilder.build(readResult.records)
        val syncClient = LifegameSyncClient(oauthManager)
        var accepted = 0
        payload.batches.forEachIndexed { index, batch ->
            screenState = screenState.copy(
                syncMessage = "lifegameへ送信しています… (${index + 1}/${payload.batches.size})",
            )
            accepted += syncClient.post(batch.body)
        }
        // A token advances only after every batch was accepted. A failed POST retries the same
        // changes next time, while external_id upsert keeps retries safe on the server.
        syncTokenStore.save(HealthSyncTokenPolicy.tokensToSave(readResult.nextTokens, payload.skippedTypes))
        val completedAt = Instant.now()
        val syncResult = HealthSyncResult(
            sentCount = payload.sentCount,
            acceptedCount = accepted,
            skippedCount = payload.skippedCount,
            completedAt = completedAt,
        )
        syncResultStore.save(syncResult)
        screenState = screenState.copy(
            isSyncing = false,
            syncMessage = null,
            lastSyncedAt = completedAt,
            lastSyncResult = syncResult,
            syncErrorMessage = null,
        )
        refresh()
    }

    private fun openHealthConnectSettings() {
        runCatching {
            startActivity(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS))
        }
    }
}

@Composable
internal fun HealthConnectScreen(
    state: HealthConnectScreenState,
    onRequestPermissions: () -> Unit,
    onRefresh: () -> Unit,
    onSyncNow: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenPrivacyPolicy: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            // targetSdk 35 では Android 15 以降が edge-to-edge を強制する。inset を
            // スクロールの内側で確保しないと、末尾のボタンがナビゲーションバーの
            // 下に入って押せなくなる。
            .safeDrawingPadding()
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text = "lifegame 健康確認",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
        )
        Text(
            text = "Health Connectの直近30日の健康記録を確認します。体重測定と運動実績は手動で同期できます。",
            style = MaterialTheme.typography.bodyLarge,
        )

        AvailabilityCard(
            availability = state.availability,
            errorMessage = state.errorMessage,
            onOpenSettings = onOpenSettings,
        )

        if (state.availability == HealthConnectAvailability.AVAILABLE) {
            PermissionCard(
                grantedPermissions = state.grantedPermissions,
                onRequestPermissions = onRequestPermissions,
            )

            state.summaries.forEach { summary -> SummaryCard(summary) }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedButton(
                    modifier = Modifier.weight(1f),
                    onClick = onRefresh,
                    enabled = !state.isRefreshing,
                ) {
                    Text("再読み込み")
                }
                Button(
                    modifier = Modifier.weight(1f),
                    onClick = onSyncNow,
                    enabled = !state.isSyncing && !state.isRefreshing,
                ) {
                    Text("今すぐ同期")
                }
                if (state.isRefreshing || state.isSyncing) {
                    CircularProgressIndicator(
                        modifier = Modifier.align(Alignment.CenterVertically),
                    )
                }
            }
            state.syncMessage?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium)
            }
            state.syncErrorMessage?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            state.lastSyncedAt?.let {
                Text("最終同期: ${formatSyncTime(it)}", style = MaterialTheme.typography.bodyMedium)
            }
            state.lastSyncResult?.let { result ->
                Text(
                    "直近の同期: 送信 ${result.sentCount}件・受理 ${result.acceptedCount}件",
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (result.skippedCount > 0) {
                    Text(
                        "未同期のまま端末に残っている記録: ${result.skippedCount}件（次回も同期対象です）",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }

        HorizontalDivider(modifier = Modifier.padding(top = 8.dp))
        Text(
            text = "体重測定と運動実績は、今すぐ同期を押したときだけlifegameへ送信します。睡眠実績は送信せず、自動同期も行いません。",
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedButton(onClick = onOpenPrivacyPolicy) {
            Text("プライバシーポリシーの全文を開く")
        }
    }
}

private fun formatSyncTime(instant: Instant): String =
    DateTimeFormatter.ofPattern("yyyy年M月d日 HH:mm", Locale.JAPAN)
        .withZone(ZoneId.systemDefault())
        .format(instant)

private fun Intent.isLifegameOAuthCallback(): Boolean =
    data?.scheme == LIFEGAME_REDIRECT_URI.substringBefore(':')

private fun Exception.userMessage(fallback: String): String = when (this) {
    is SyncAuthenticationRequiredException -> message ?: "再接続してください。"
    is SyncApiException -> message ?: fallback
    is OAuthException -> message ?: fallback
    else -> fallback
}

@Composable
private fun AvailabilityCard(
    availability: HealthConnectAvailability?,
    errorMessage: String?,
    onOpenSettings: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Health Connect", style = MaterialTheme.typography.titleLarge)
            when (availability) {
                null -> Text("確認中…")
                HealthConnectAvailability.AVAILABLE -> Text("利用できます。")
                HealthConnectAvailability.PROVIDER_UPDATE_REQUIRED -> {
                    Text("Health Connectの更新が必要です。設定から更新してください。")
                    Button(onClick = onOpenSettings) { Text("Health Connectの設定を開く") }
                }
                HealthConnectAvailability.UNAVAILABLE -> Text(
                    "この端末ではHealth Connectを利用できません。Android 9以降か、Google Play対応端末で確認してください。",
                )
            }
            errorMessage?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
}

@Composable
private fun PermissionCard(
    grantedPermissions: Set<String>,
    onRequestPermissions: () -> Unit,
) {
    val missing = HealthDataType.entries.filter { it.permission !in grantedPermissions }
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("読み取り権限", style = MaterialTheme.typography.titleLarge)
            HealthDataType.entries.forEach { type ->
                val granted = type.permission in grantedPermissions
                Text("${type.label}: ${if (granted) "許可" else "未許可"}")
            }
            if (missing.isNotEmpty()) {
                Button(onClick = onRequestPermissions) {
                    Text("未許可の読み取り権限を設定")
                }
                Text(
                    "種類ごとに許可・拒否できます。拒否した種類は読み取りません。",
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                Text("3種類すべての読み取りが許可されています。")
            }
        }
    }
}

@Composable
private fun SummaryCard(summary: HealthDataSummary) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(summary.type.label, style = MaterialTheme.typography.titleLarge)
            when (summary.access) {
                SummaryAccess.NOT_GRANTED -> Text("権限が未許可のため表示できません。")
                SummaryAccess.READ_FAILED -> Text(
                    summary.errorMessage ?: "読み取れませんでした。",
                    color = MaterialTheme.colorScheme.error,
                )
                SummaryAccess.GRANTED -> {
                    Text("直近30日の件数: ${summary.count}件")
                    Text(
                        summary.preview ?: "データはありません。",
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
        }
    }
}

/**
 * ADR 0001: 全文は ACTION_VIEW でブラウザに渡す。アプリは手動同期のため INTERNET 権限を
 * 持つが、ポリシー本文の表示と認証セッションはChromeに委ねる。
 *
 * 生成を startActivity から切り離してあるのは、何を投げているかをテストから直接読めるようにするため。
 */
internal fun privacyPolicyIntent(): Intent = Intent(Intent.ACTION_VIEW, PrivacyPolicy.URL.toUri())

private fun ComponentActivity.openPrivacyPolicy() {
    try {
        startActivity(privacyPolicyIntent())
    } catch (_: ActivityNotFoundException) {
        // ブラウザがない、または仕事用プロファイルで web intent が転送されない場合。
        // 黙って何も起きないと、全文へ辿り着く手段がなくなる。
        showPolicyUnavailable()
    } catch (_: SecurityException) {
        showPolicyUnavailable()
    }
}

// ここで Throwable ごと握ると、こちらの実装ミスまで「ブラウザを開けません」と
// 表示して隠してしまう。捕まえるのは起動そのものが拒まれた2つだけにする。
private fun ComponentActivity.showPolicyUnavailable() {
    Toast.makeText(this, "ブラウザを開けませんでした。${PrivacyPolicy.URL}", Toast.LENGTH_LONG).show()
}

@Composable
private fun LifegameCompanionTheme(content: @Composable () -> Unit) {
    MaterialTheme(content = content)
}

class PermissionsRationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            LifegameCompanionTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                            .safeDrawingPadding()
                            .padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Text("lifegame 健康確認のプライバシー説明", style = MaterialTheme.typography.headlineSmall)
                        // 権限を判断するその場で読めることに意味があるので要約を残す。
                        // ただし細部は書かず、全文が正であることを画面上で明示する。
                        // 件数はリストから数える。ADR 0001 が点数を動かしたとき、
                        // 本文だけが古い数を言い続けるのを型で防ぐ手段がないため。
                        Text("要点は次の${PrivacyPolicy.summary.size}つです。")
                        PrivacyPolicy.summary.forEach { point -> Text("・$point") }
                        Text(
                            "全文はWebで公開しているものが正式な内容です。",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Button(onClick = { openPrivacyPolicy() }) { Text("プライバシーポリシーの全文を開く") }
                        OutlinedButton(onClick = ::finish) { Text("閉じる") }
                    }
                }
            }
        }
    }
}
