package com.tachicoma.lifegame.companion

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.WeightRecord
import com.tachicoma.lifegame.health.HealthDataType

enum class HealthConnectAvailability {
    AVAILABLE,
    UPDATE_REQUIRED,
    UNAVAILABLE,
}

object HealthConnectAccess {
    val permissionByType: Map<HealthDataType, String> =
        mapOf(
            HealthDataType.WEIGHT to HealthPermission.getReadPermission(WeightRecord::class),
            HealthDataType.EXERCISE to HealthPermission.getReadPermission(ExerciseSessionRecord::class),
            HealthDataType.SLEEP to HealthPermission.getReadPermission(SleepSessionRecord::class),
        )

    val requiredPermissions: Set<String> = permissionByType.values.toSet()

    fun availability(context: Context): HealthConnectAvailability =
        when (HealthConnectClient.getSdkStatus(context)) {
            HealthConnectClient.SDK_AVAILABLE -> HealthConnectAvailability.AVAILABLE
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED ->
                HealthConnectAvailability.UPDATE_REQUIRED
            else -> HealthConnectAvailability.UNAVAILABLE
        }

    fun grantedTypes(grantedPermissions: Set<String>): Set<HealthDataType> =
        permissionByType
            .filterValues { permission -> permission in grantedPermissions }
            .keys
}
