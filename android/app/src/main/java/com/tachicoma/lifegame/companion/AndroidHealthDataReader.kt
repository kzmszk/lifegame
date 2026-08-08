package com.tachicoma.lifegame.companion

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.tachicoma.lifegame.health.ExerciseSession
import com.tachicoma.lifegame.health.HealthDataReader
import com.tachicoma.lifegame.health.HealthDataType
import com.tachicoma.lifegame.health.HealthReadWindow
import com.tachicoma.lifegame.health.HealthSnapshot
import com.tachicoma.lifegame.health.SleepSession
import com.tachicoma.lifegame.health.WeightMeasurement
import kotlin.reflect.KClass

class AndroidHealthDataReader(
    private val client: HealthConnectClient,
) : HealthDataReader {
    override suspend fun read(
        allowedTypes: Set<HealthDataType>,
        window: HealthReadWindow,
    ): HealthSnapshot =
        HealthSnapshot(
            weights =
                if (HealthDataType.WEIGHT in allowedTypes) {
                    readAll(WeightRecord::class, window)
                        .map { record -> WeightMeasurement(record.weight.inKilograms, record.time) }
                } else {
                    emptyList()
                },
            exercises =
                if (HealthDataType.EXERCISE in allowedTypes) {
                    readAll(ExerciseSessionRecord::class, window)
                        .map { record ->
                            ExerciseSession(
                                name = record.title?.takeIf(String::isNotBlank) ?: exerciseName(record.exerciseType),
                                startedAt = record.startTime,
                                endedAt = record.endTime,
                            )
                        }
                } else {
                    emptyList()
                },
            sleeps =
                if (HealthDataType.SLEEP in allowedTypes) {
                    readAll(SleepSessionRecord::class, window)
                        .map { record -> SleepSession(record.startTime, record.endTime) }
                } else {
                    emptyList()
                },
        )

    private suspend fun <T : Record> readAll(
        recordType: KClass<T>,
        window: HealthReadWindow,
    ): List<T> {
        val records = mutableListOf<T>()
        var pageToken: String? = null
        do {
            val response =
                client.readRecords(
                    ReadRecordsRequest(
                        recordType = recordType,
                        timeRangeFilter = TimeRangeFilter.between(window.startedAt, window.endedAt),
                        ascendingOrder = false,
                        pageToken = pageToken,
                    ),
                )
            records += response.records
            pageToken = response.pageToken
        } while (pageToken != null)
        return records
    }

    private fun exerciseName(exerciseType: Int): String =
        when (exerciseType) {
            ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "ウォーキング"
            ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
            ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "ランニング"
            ExerciseSessionRecord.EXERCISE_TYPE_BIKING,
            ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> "サイクリング"
            ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL -> "水泳"
            ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING -> "筋力トレーニング"
            ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "ハイキング"
            ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "ヨガ"
            else -> "運動"
        }
}
