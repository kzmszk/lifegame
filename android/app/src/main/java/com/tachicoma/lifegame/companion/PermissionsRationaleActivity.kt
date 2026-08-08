package com.tachicoma.lifegame.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tachicoma.lifegame.health.HealthDataType

/**
 * Health Connect が要求する権限説明画面。ACTION_SHOW_PERMISSIONS_RATIONALE と
 * VIEW_PERMISSION_USAGE の両方から起動される。
 */
class PermissionsRationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    PermissionsRationaleScreen()
                }
            }
        }
    }
}

@Composable
private fun PermissionsRationaleScreen() {
    Column(
        modifier =
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = stringResource(R.string.rationale_title),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            text =
                stringResource(
                    R.string.rationale_body,
                    HealthDataType.entries.joinToString("・") { type -> type.displayName },
                ),
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(
            text = stringResource(R.string.rationale_no_transfer),
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}
