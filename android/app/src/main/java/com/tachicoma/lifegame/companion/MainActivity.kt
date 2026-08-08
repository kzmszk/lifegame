package com.tachicoma.lifegame.companion

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tachicoma.lifegame.health.HealthDataType
import com.tachicoma.lifegame.health.HealthPreviewItem

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    HealthPreviewScreen()
                }
            }
        }
    }
}

@Composable
private fun HealthPreviewScreen(viewModel: HealthPreviewViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    val permissionLauncher =
        rememberLauncherForActivityResult(
            PermissionController.createRequestPermissionResultContract(),
        ) { viewModel.refresh() }

    LaunchedEffect(Unit) { viewModel.refresh() }

    Column(
        modifier =
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = stringResource(R.string.app_name),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            text = stringResource(R.string.read_only_notice),
            style = MaterialTheme.typography.bodyMedium,
        )

        when (val current = state) {
            HealthUiState.Loading ->
                CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))

            is HealthUiState.ProviderUnavailable -> ProviderUnavailableSection(current.availability)

            HealthUiState.PermissionsRequired ->
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.permissions_required))
                    Button(onClick = { permissionLauncher.launch(viewModel.requiredPermissions) }) {
                        Text(stringResource(R.string.grant_permissions))
                    }
                }

            is HealthUiState.Ready ->
                ReadySection(
                    state = current,
                    onRequestPermissions = { permissionLauncher.launch(viewModel.requiredPermissions) },
                    onRefresh = viewModel::refresh,
                )

            is HealthUiState.Failed ->
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.read_failed, current.message))
                    OutlinedButton(onClick = viewModel::refresh) {
                        Text(stringResource(R.string.retry))
                    }
                }
        }
    }
}

@Composable
private fun ProviderUnavailableSection(availability: HealthConnectAvailability) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val message =
        when (availability) {
            HealthConnectAvailability.UPDATE_REQUIRED -> R.string.provider_update_required
            else -> R.string.provider_unavailable
        }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(message))
        Button(onClick = { context.openHealthConnectListing() }) {
            Text(stringResource(R.string.open_health_connect_listing))
        }
    }
}

@Composable
private fun ReadySection(
    state: HealthUiState.Ready,
    onRequestPermissions: () -> Unit,
    onRefresh: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (state.missing.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    stringResource(
                        R.string.permissions_partially_granted,
                        state.missing.joinToString("・") { type -> type.displayName },
                    ),
                )
                OutlinedButton(onClick = onRequestPermissions) {
                    Text(stringResource(R.string.grant_permissions))
                }
            }
        }

        PreviewSection(HealthDataType.WEIGHT, state.granted, state.preview.weights)
        PreviewSection(HealthDataType.EXERCISE, state.granted, state.preview.exercises)
        PreviewSection(HealthDataType.SLEEP, state.granted, state.preview.sleeps)

        OutlinedButton(onClick = onRefresh) {
            Text(stringResource(R.string.refresh))
        }
    }
}

@Composable
private fun PreviewSection(
    type: HealthDataType,
    granted: Set<HealthDataType>,
    items: List<HealthPreviewItem>,
) {
    if (type !in granted) return

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = stringResource(R.string.section_title, type.displayName, items.size),
            style = MaterialTheme.typography.titleMedium,
        )
        if (items.isEmpty()) {
            Text(
                text = stringResource(R.string.section_empty),
                style = MaterialTheme.typography.bodyMedium,
            )
        } else {
            items.forEach { item ->
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(item.headline, style = MaterialTheme.typography.bodyLarge)
                        Text(item.supportingText, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

private fun Context.openHealthConnectListing() {
    val listing =
        Uri.parse(
            "market://details" +
                "?id=$HEALTH_CONNECT_PACKAGE" +
                "&url=healthconnect%3A%2F%2Fonboarding",
        )
    runCatching { startActivity(Intent(Intent.ACTION_VIEW, listing)) }
        .recoverCatching { failure ->
            if (failure !is ActivityNotFoundException) throw failure
            startActivity(
                Intent(
                    Intent.ACTION_VIEW,
                    Uri.parse("https://play.google.com/store/apps/details?id=$HEALTH_CONNECT_PACKAGE"),
                ),
            )
        }
}

private const val HEALTH_CONNECT_PACKAGE = "com.google.android.apps.healthdata"
