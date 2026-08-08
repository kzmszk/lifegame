package com.tachicoma.lifegame.companion

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.health.connect.client.HealthConnectClient
import com.tachicoma.lifegame.health.HealthDataType
import com.tachicoma.lifegame.health.HealthPreview
import com.tachicoma.lifegame.health.HealthPreviewFormatter
import com.tachicoma.lifegame.health.HealthReadWindow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId

/**
 * 端末内プレビューの画面状態。読み取った健康データは画面に出すだけで、端末外へは一切送らない。
 */
sealed interface HealthUiState {
    data object Loading : HealthUiState

    /** Health Connect が使えない、または更新が必要。 */
    data class ProviderUnavailable(
        val availability: HealthConnectAvailability,
    ) : HealthUiState

    /** Health Connect は使えるが、読み取り権限がまだ 1 つも無い。 */
    data object PermissionsRequired : HealthUiState

    data class Ready(
        val granted: Set<HealthDataType>,
        val preview: HealthPreview,
    ) : HealthUiState {
        val missing: Set<HealthDataType>
            get() = HealthDataType.entries.toSet() - granted
    }

    data class Failed(
        val message: String,
    ) : HealthUiState
}

class HealthPreviewViewModel(
    application: Application,
) : AndroidViewModel(application) {
    private val formatter = HealthPreviewFormatter(ZoneId.systemDefault())

    private val mutableState = MutableStateFlow<HealthUiState>(HealthUiState.Loading)
    val state: StateFlow<HealthUiState> = mutableState.asStateFlow()

    /** 権限リクエストの起点。UI から launcher に渡す。 */
    val requiredPermissions: Set<String> = HealthConnectAccess.requiredPermissions

    fun refresh() {
        viewModelScope.launch {
            mutableState.value = HealthUiState.Loading

            val context = getApplication<Application>()
            val availability = HealthConnectAccess.availability(context)
            if (availability != HealthConnectAvailability.AVAILABLE) {
                mutableState.value = HealthUiState.ProviderUnavailable(availability)
                return@launch
            }

            mutableState.value =
                runCatching {
                    val client = HealthConnectClient.getOrCreate(context)
                    val granted =
                        HealthConnectAccess.grantedTypes(
                            client.permissionController.getGrantedPermissions(),
                        )
                    if (granted.isEmpty()) {
                        HealthUiState.PermissionsRequired
                    } else {
                        val snapshot =
                            AndroidHealthDataReader(client)
                                .read(granted, HealthReadWindow.last30Days(Instant.now()))
                        HealthUiState.Ready(granted, formatter.format(snapshot))
                    }
                }.getOrElse { failure ->
                    HealthUiState.Failed(failure.message ?: failure.javaClass.simpleName)
                }
        }
    }
}
