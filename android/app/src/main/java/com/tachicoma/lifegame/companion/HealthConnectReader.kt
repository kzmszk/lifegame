package com.tachicoma.lifegame.companion

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Clock
import java.time.Instant

data class HealthConnectReadResult(
    val grantedPermissions: Set<String>,
    val summaries: List<HealthDataSummary>,
    val readAt: Instant,
)

enum class HealthSyncType(val preferenceKey: String) {
    WEIGHT("weight_changes_token"),
    EXERCISE("exercise_changes_token"),
}

class HealthSyncTokenStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun get(type: HealthSyncType): String? = preferences.getString(type.preferenceKey, null)

    fun save(tokens: Map<HealthSyncType, String>) {
        val editor = preferences.edit()
        tokens.forEach { (type, token) -> editor.putString(type.preferenceKey, token) }
        editor.apply()
    }

    private companion object {
        const val PREFERENCES_NAME = "lifegame.health_sync"
    }
}

class HealthSyncResultStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun load(): HealthSyncResult? {
        val completedAt = preferences.getLong(KEY_COMPLETED_AT, -1L)
        if (completedAt < 0L) return null
        return HealthSyncResult(
            sentCount = preferences.getInt(KEY_SENT_COUNT, 0),
            acceptedCount = preferences.getInt(KEY_ACCEPTED_COUNT, 0),
            skippedCount = preferences.getInt(KEY_SKIPPED_COUNT, 0),
            completedAt = Instant.ofEpochMilli(completedAt),
        )
    }

    fun save(result: HealthSyncResult) {
        preferences.edit()
            .putLong(KEY_COMPLETED_AT, result.completedAt.toEpochMilli())
            .putInt(KEY_SENT_COUNT, result.sentCount)
            .putInt(KEY_ACCEPTED_COUNT, result.acceptedCount)
            .putInt(KEY_SKIPPED_COUNT, result.skippedCount)
            .apply()
    }

    private companion object {
        const val PREFERENCES_NAME = "lifegame.health_sync_result"
        const val KEY_COMPLETED_AT = "completed_at"
        const val KEY_SENT_COUNT = "sent_count"
        const val KEY_ACCEPTED_COUNT = "accepted_count"
        const val KEY_SKIPPED_COUNT = "skipped_count"
    }
}

data class HealthConnectSyncReadResult(
    val records: List<HealthSyncRecord>,
    val nextTokens: Map<HealthSyncType, String>,
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

    suspend fun readChanges(tokenStore: HealthSyncTokenStore): HealthConnectSyncReadResult {
        val granted = client.permissionController.getGrantedPermissions()
        val records = mutableListOf<HealthSyncRecord>()
        val nextTokens = mutableMapOf<HealthSyncType, String>()

        if (HealthPermissions.READ_WEIGHT in granted) {
            try {
                val result = readWeightChanges(tokenStore.get(HealthSyncType.WEIGHT))
                records += result.records
                nextTokens[HealthSyncType.WEIGHT] = result.nextToken
            } catch (error: SecurityException) {
                // Permission can be revoked between getGrantedPermissions and getChanges. Treat
                // that race like a normal denied type; other failures still stop this sync.
            }
        }

        if (HealthPermissions.READ_EXERCISE in granted) {
            try {
                val result = readExerciseChanges(tokenStore.get(HealthSyncType.EXERCISE))
                records += result.records
                nextTokens[HealthSyncType.EXERCISE] = result.nextToken
            } catch (_: SecurityException) {
                // See the weight branch above.
            }
        }

        return HealthConnectSyncReadResult(records = records, nextTokens = nextTokens)
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
                WeightMeasurement(
                    measuredAt = it.time,
                    zoneOffset = it.zoneOffset,
                    kilograms = it.weight.inKilograms,
                    externalId = it.metadata.id,
                )
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
                ExerciseSession(
                    startedAt = it.startTime,
                    endedAt = it.endTime,
                    startZoneOffset = it.startZoneOffset,
                    endZoneOffset = it.endZoneOffset,
                    title = it.title?.takeIf(String::isNotBlank) ?: exerciseTypeName(it.exerciseType),
                    externalId = it.metadata.id,
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
                SleepSession(
                    startedAt = it.startTime,
                    endedAt = it.endTime,
                    startZoneOffset = it.startZoneOffset,
                    endZoneOffset = it.endZoneOffset,
                    title = it.title,
                )
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

    private suspend fun readWeightChanges(storedToken: String?): TypeChanges {
        val initialToken = storedToken ?: client.getChangesToken(
            ChangesTokenRequest(recordTypes = setOf(WeightRecord::class)),
        )
        if (storedToken == null) {
            val records = readAll<WeightRecord>(rangeForNow())
                .map { it.toSyncRecord() }
            return TypeChanges(records, initialToken)
        }

        return readChanges(initialToken, WeightRecord::class) { record -> record.toSyncRecord() }
    }

    private suspend fun readExerciseChanges(storedToken: String?): TypeChanges {
        val initialToken = storedToken ?: client.getChangesToken(
            ChangesTokenRequest(recordTypes = setOf(ExerciseSessionRecord::class)),
        )
        if (storedToken == null) {
            val records = readAll<ExerciseSessionRecord>(rangeForNow())
                .map { it.toSyncRecord() }
            return TypeChanges(records, initialToken)
        }

        return readChanges(initialToken, ExerciseSessionRecord::class) { record -> record.toSyncRecord() }
    }

    private suspend fun <T : Record> readChanges(
        token: String,
        recordType: kotlin.reflect.KClass<T>,
        map: (T) -> HealthSyncRecord,
    ): TypeChanges {
        val records = mutableListOf<HealthSyncRecord>()
        var currentToken = token
        do {
            val response = client.getChanges(currentToken)
            if (response.changesTokenExpired) {
                val replacementToken = client.getChangesToken(ChangesTokenRequest(recordTypes = setOf(recordType)))
                val fullRecords = when (recordType) {
                    WeightRecord::class -> readAll<WeightRecord>(rangeForNow()).map { map(it as T) }
                    ExerciseSessionRecord::class -> readAll<ExerciseSessionRecord>(rangeForNow()).map { map(it as T) }
                    else -> emptyList()
                }
                return TypeChanges(fullRecords, replacementToken)
            }
            response.changes.forEach { change ->
                val record = (change as? UpsertionChange)?.record
                if (record != null && recordType.isInstance(record)) {
                    @Suppress("UNCHECKED_CAST")
                    records += map(record as T)
                }
            }
            currentToken = response.nextChangesToken
        } while (response.hasMore)
        return TypeChanges(records, currentToken)
    }

    private fun rangeForNow(): TimeRangeFilter = TimeRangeFilter.between(HealthReadWindow.start(clock.instant()), clock.instant())

    private fun WeightRecord.toSyncRecord() = HealthSyncRecord.Weight(
        externalId = metadata.id,
        measuredAt = time,
        zoneOffset = zoneOffset,
        kilograms = weight.inKilograms,
    )

    private fun ExerciseSessionRecord.toSyncRecord() = HealthSyncRecord.Exercise(
        externalId = metadata.id,
        startedAt = startTime,
        endedAt = endTime,
        startZoneOffset = startZoneOffset,
        title = title?.takeIf(String::isNotBlank) ?: exerciseTypeName(exerciseType),
    )

    private data class TypeChanges(
        val records: List<HealthSyncRecord>,
        val nextToken: String,
    )

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
