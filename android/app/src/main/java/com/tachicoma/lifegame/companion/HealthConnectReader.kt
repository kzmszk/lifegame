package com.tachicoma.lifegame.companion

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Clock
import java.time.Instant
import java.time.temporal.ChronoUnit

data class HealthConnectReadResult(
    val grantedPermissions: Set<String>,
    val summaries: List<HealthDataSummary>,
    val readAt: Instant,
)

class HealthConnectReader(
    private val client: HealthConnectClient,
    private val clock: Clock = Clock.systemUTC(),
) {
    suspend fun read(): HealthConnectReadResult {
        val granted = client.permissionController.getGrantedPermissions()
        val end = clock.instant()
        val start = HealthReadWindow.start(end)
        val range = TimeRangeFilter.between(start, end)

        return HealthConnectReadResult(
            grantedPermissions = granted,
            summaries = listOf(
                readWeight(granted, range),
                readExercise(granted, range),
                readSleep(granted, range),
            ),
            readAt = end,
        )
    }

    private suspend fun readWeight(
        granted: Set<String>,
        range: TimeRangeFilter,
    ): HealthDataSummary {
        if (HealthPermissions.READ_WEIGHT !in granted) {
            return HealthSummaryFormatter.notGranted(HealthDataType.WEIGHT)
        }
        return try {
            val samples = readAll<WeightRecord>(range).map {
                WeightSample(it.time, it.weight.inKilograms)
            }
            HealthSummaryFormatter.weight(samples)
        } catch (_: SecurityException) {
            HealthSummaryFormatter.failed(HealthDataType.WEIGHT, "権限が取り消されたため読み取れません。")
        } catch (_: Exception) {
            HealthSummaryFormatter.failed(HealthDataType.WEIGHT, "Health Connectから読み取れませんでした。")
        }
    }

    private suspend fun readExercise(
        granted: Set<String>,
        range: TimeRangeFilter,
    ): HealthDataSummary {
        if (HealthPermissions.READ_EXERCISE !in granted) {
            return HealthSummaryFormatter.notGranted(HealthDataType.EXERCISE)
        }
        return try {
            val samples = readAll<ExerciseSessionRecord>(range).map {
                ExerciseSample(
                    startedAt = it.startTime,
                    endedAt = it.endTime,
                    title = it.title?.takeIf(String::isNotBlank) ?: exerciseTypeName(it.exerciseType),
                )
            }
            HealthSummaryFormatter.exercise(samples)
        } catch (_: SecurityException) {
            HealthSummaryFormatter.failed(HealthDataType.EXERCISE, "権限が取り消されたため読み取れません。")
        } catch (_: Exception) {
            HealthSummaryFormatter.failed(HealthDataType.EXERCISE, "Health Connectから読み取れませんでした。")
        }
    }

    private suspend fun readSleep(
        granted: Set<String>,
        range: TimeRangeFilter,
    ): HealthDataSummary {
        if (HealthPermissions.READ_SLEEP !in granted) {
            return HealthSummaryFormatter.notGranted(HealthDataType.SLEEP)
        }
        return try {
            val samples = readAll<SleepSessionRecord>(range).map {
                SleepSample(it.startTime, it.endTime, it.title)
            }
            HealthSummaryFormatter.sleep(samples)
        } catch (_: SecurityException) {
            HealthSummaryFormatter.failed(HealthDataType.SLEEP, "権限が取り消されたため読み取れません。")
        } catch (_: Exception) {
            HealthSummaryFormatter.failed(HealthDataType.SLEEP, "Health Connectから読み取れませんでした。")
        }
    }

    private suspend inline fun <reified T : Record> readAll(range: TimeRangeFilter): List<T> {
        val records = mutableListOf<T>()
        var pageToken: String? = null
        do {
            val response = client.readRecords(
                ReadRecordsRequest(
                    recordType = T::class,
                    timeRangeFilter = range,
                    pageToken = pageToken,
                ),
            )
            records += response.records
            pageToken = response.pageToken
        } while (pageToken != null)
        return records
    }

    private fun exerciseTypeName(type: Int): String = when (type) {
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "ウォーキング"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING -> "ランニング"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING -> "自転車"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL,
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER -> "水泳"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING,
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING -> "筋力トレーニング"
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "ヨガ"
        else -> "運動実績"
    }
}
