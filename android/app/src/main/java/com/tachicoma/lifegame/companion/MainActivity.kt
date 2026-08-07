package com.tachicoma.lifegame.companion

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.lifecycle.lifecycleScope
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private var screenState by mutableStateOf(HealthConnectScreenState())

    private val permissionLauncher = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
    ) {
        refresh()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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
                        onOpenSettings = ::openHealthConnectSettings,
                    )
                }
            }
        }
        refresh()
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
                        screenState = HealthConnectScreenState(
                            availability = HealthConnectAvailability.AVAILABLE,
                            grantedPermissions = result.grantedPermissions,
                            summaries = result.summaries,
                        )
                    } catch (_: Exception) {
                        screenState = HealthConnectScreenState(
                            availability = HealthConnectAvailability.AVAILABLE,
                            errorMessage = "Health Connectの状態を確認できませんでした。もう一度試してください。",
                        )
                    }
                }

                HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                    screenState = HealthConnectScreenState(
                        availability = HealthConnectAvailability.PROVIDER_UPDATE_REQUIRED,
                    )
                }

                else -> {
                    screenState = HealthConnectScreenState(
                        availability = HealthConnectAvailability.UNAVAILABLE,
                    )
                }
            }
        }
    }

    private fun openHealthConnectSettings() {
        runCatching {
            startActivity(Intent(HealthConnectClient.getHealthConnectSettingsAction()))
        }
    }
}

@Composable
private fun HealthConnectScreen(
    state: HealthConnectScreenState,
    onRequestPermissions: () -> Unit,
    onRefresh: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text = "lifegame 健康確認",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
        )
        Text(
            text = "Health Connectの直近30日を、この端末の画面だけで確認します。",
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
                if (state.isRefreshing) {
                    CircularProgressIndicator(
                        modifier = Modifier.align(Alignment.CenterVertically),
                    )
                }
            }
        }

        HorizontalDivider(modifier = Modifier.padding(top = 8.dp))
        Text(
            text = "この試作版は読み取り専用です。体重・運動実績・睡眠を端末内に表示するだけで、Health Connectへの書き込み、lifegameサーバーへの送信、バックグラウンド同期は行いません。",
            style = MaterialTheme.typography.bodyMedium,
        )
    }
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
                            .padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Text("lifegame 健康確認のプライバシー説明", style = MaterialTheme.typography.headlineSmall)
                        Text(
                            "このアプリは、利用者が許可した体重・運動実績・睡眠の読み取り権限だけを使い、直近30日の代表項目と件数を端末画面に表示します。",
                        )
                        Text(
                            "データはHealth Connectから読み取るだけです。Health Connectへの書き込み、サーバーへの送信、広告・分析への利用、バックグラウンド同期は行いません。",
                        )
                        Button(onClick = ::finish) { Text("閉じる") }
                    }
                }
            }
        }
    }
}
