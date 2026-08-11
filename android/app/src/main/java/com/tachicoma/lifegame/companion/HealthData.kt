package com.tachicoma.lifegame.companion

import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.nio.charset.StandardCharsets
import java.util.Locale

/** The only Health Connect permissions this prototype can declare or request. */
object HealthPermissions {
    const val READ_WEIGHT = "android.permission.health.READ_WEIGHT"
    const val READ_EXERCISE = "android.permission.health.READ_EXERCISE"
    const val READ_SLEEP = "android.permission.health.READ_SLEEP"

    val all: Set<String> = setOf(READ_WEIGHT, READ_EXERCISE, READ_SLEEP)
}

/**
 * ADR 0001: the public page is the single source of truth for the privacy policy.
 *
 * The rationale screen only repeats the points below, so that editing the details of the full
 * text never leaves the on-device wording saying something different. Both the rationale screen
 * and the main screen open the same URL.
 *
 * Sending splits the second point into three facts a reader has to have before granting the
 * permission — what leaves the device, where it goes, and when — so ADR 0001 fixes the summary at
 * four points rather than making one sentence carry all of it. Sleep gets its own line because
 * "we read it but never send it" is the kind of distinction that disappears inside a longer one.
 */
object PrivacyPolicy {
    const val URL = "https://lifegame.tachicoma.com/privacy"

    val summary: List<String> = listOf(
        "読み取るのは体重測定・運動実績・睡眠実績の3種類だけです。",
        "体重測定と運動実績は、あなたが同期を押したときだけ lifegame（lifegame.tachicoma.com）へ送ります。",
        "睡眠実績は端末の外へ送りません。自動での送信もしません。",
        "第三者提供・広告・分析には使いません。",
    )
}

enum class HealthDataType(
    val label: String,
    val permission: String,
) {
    WEIGHT("体重測定", HealthPermissions.READ_WEIGHT),
    EXERCISE("運動実績", HealthPermissions.READ_EXERCISE),
    SLEEP("睡眠実績", HealthPermissions.READ_SLEEP),
}

enum class SummaryAccess {
    NOT_GRANTED,
    GRANTED,
    READ_FAILED,
}

data class HealthDataSummary(
    val type: HealthDataType,
    val access: SummaryAccess,
    val count: Int = 0,
    val preview: String? = null,
    val errorMessage: String? = null,
)

data class WeightMeasurement(
    val measuredAt: Instant,
    val zoneOffset: ZoneOffset?,
    val kilograms: Double,
    val externalId: String = "",
)

data class ExerciseSession(
    val startedAt: Instant,
    val endedAt: Instant,
    val startZoneOffset: ZoneOffset?,
    val endZoneOffset: ZoneOffset?,
    val title: String,
    val externalId: String = "",
)

data class SleepSession(
    val startedAt: Instant,
    val endedAt: Instant,
    val startZoneOffset: ZoneOffset?,
    val endZoneOffset: ZoneOffset?,
    val title: String?,
)

enum class HealthConnectAvailability {
    AVAILABLE,
    PROVIDER_UPDATE_REQUIRED,
    UNAVAILABLE,
}

data class HealthConnectScreenState(
    val availability: HealthConnectAvailability? = null,
    val grantedPermissions: Set<String> = emptySet(),
    val summaries: List<HealthDataSummary> = HealthDataType.entries.map {
        HealthDataSummary(it, SummaryAccess.NOT_GRANTED)
    },
    val isRefreshing: Boolean = false,
    val errorMessage: String? = null,
    val isSyncing: Boolean = false,
    val syncMessage: String? = null,
    // Kept apart from errorMessage, which belongs to the Health Connect card at the top of the
    // page. A sync failure reported up there is off-screen from the button that caused it.
    val syncErrorMessage: String? = null,
    val lastSyncedAt: Instant? = null,
    val lastSyncResult: HealthSyncResult? = null,
)

data class HealthSyncResult(
    val sentCount: Int,
    val acceptedCount: Int,
    val skippedCount: Int,
    val completedAt: Instant,
)

object HealthReadWindow {
    const val DAYS = 30L

    fun start(now: Instant): Instant = now.minus(Duration.ofDays(DAYS))
}

/**
 * The one place a session length becomes whole minutes. The screen and the payload both go
 * through it so the same session cannot read 9分 on the device and arrive as 10 in lifegame,
 * which is what happened while the screen floored and the payload rounded.
 */
object HealthDuration {
    fun roundedMinutes(start: Instant, end: Instant): Long {
        val seconds = Duration.between(start, end).seconds
        if (seconds <= 0L) return 0L
        return seconds / 60L + if (seconds % 60L >= 30L) 1L else 0L
    }
}

/** Records that are eligible for the write-only /sync endpoint. Sleep is deliberate here. */
sealed interface HealthSyncRecord {
    val externalId: String

    data class Weight(
        override val externalId: String,
        val measuredAt: Instant,
        val zoneOffset: ZoneOffset?,
        val kilograms: Double,
    ) : HealthSyncRecord

    data class Exercise(
        override val externalId: String,
        val startedAt: Instant,
        val endedAt: Instant,
        val startZoneOffset: ZoneOffset?,
        val title: String,
    ) : HealthSyncRecord

    // Kept as an input type so a caller cannot accidentally turn a sleep record into a
    // weight/exercise payload. The builder ignores it and it is never read by sync.
    data class Sleep(
        override val externalId: String,
        val startedAt: Instant,
        val endedAt: Instant,
        val title: String?,
    ) : HealthSyncRecord
}

object HealthSyncSelection {
    fun forGrantedPermissions(
        grantedPermissions: Set<String>,
        weights: List<WeightMeasurement>,
        exercises: List<ExerciseSession>,
    ): List<HealthSyncRecord> = buildList {
        if (HealthPermissions.READ_WEIGHT in grantedPermissions) {
            addAll(weights.map {
                HealthSyncRecord.Weight(it.externalId, it.measuredAt, it.zoneOffset, it.kilograms)
            })
        }
        if (HealthPermissions.READ_EXERCISE in grantedPermissions) {
            addAll(exercises.map {
                HealthSyncRecord.Exercise(it.externalId, it.startedAt, it.endedAt, it.startZoneOffset, it.title)
            })
        }
    }
}

enum class HealthSyncKind { WEIGHT, EXERCISE }

data class HealthSyncPayloadRecord(
    val kind: HealthSyncKind,
    val externalId: String,
    val occurredAt: String,
    val weightKg: Double? = null,
    val activity: String? = null,
    val durationMinutes: Int? = null,
) {
    fun toJson(): String = buildString {
        append('{')
        append("\"kind\":")
        appendJsonString(if (kind == HealthSyncKind.WEIGHT) "weight" else "exercise")
        append(",\"external_id\":")
        appendJsonString(externalId)
        append(",\"occurred_at\":")
        appendJsonString(occurredAt)
        when (kind) {
            HealthSyncKind.WEIGHT -> {
                append(",\"weight_kg\":")
                append(weightKg!!.toString())
            }

            HealthSyncKind.EXERCISE -> {
                append(",\"activity\":")
                appendJsonString(activity!!)
                durationMinutes?.let {
                    append(",\"duration_minutes\":")
                    append(it)
                }
            }
        }
        append('}')
    }

    private fun StringBuilder.appendJsonString(value: String) {
        append('"')
        value.forEach { character ->
            when (character) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> {
                    if (character.code < 0x20) {
                        append("\\u")
                        append(character.code.toString(16).padStart(4, '0'))
                    } else {
                        append(character)
                    }
                }
            }
        }
        append('"')
    }
}

data class HealthSyncPayloadBatch(
    val records: List<HealthSyncPayloadRecord>,
    val body: String,
) {
    val bodyBytes: Int get() = body.toByteArray(StandardCharsets.UTF_8).size
}

data class HealthSyncBuildResult(
    val batches: List<HealthSyncPayloadBatch>,
    val skippedCount: Int,
    val skippedTypes: Set<HealthSyncType> = emptySet(),
) {
    val sentCount: Int get() = batches.sumOf { it.records.size }
}

object HealthSyncTokenPolicy {
    fun tokensToSave(
        nextTokens: Map<HealthSyncType, String>,
        skippedTypes: Set<HealthSyncType>,
    ): Map<HealthSyncType, String> = nextTokens.filterKeys { it !in skippedTypes }
}

/** Android-free validation and batching for the server's deliberately strict contract. */
object HealthSyncPayloadBuilder {
    const val MAX_RECORDS = 500
    const val MAX_BODY_BYTES = 512 * 1024
    private const val MAX_EXTERNAL_ID_LENGTH = 256
    private const val MAX_ACTIVITY_LENGTH = 200

    fun build(
        records: List<HealthSyncRecord>,
        fallbackZone: ZoneId = ZoneId.systemDefault(),
    ): HealthSyncBuildResult {
        val seen = mutableSetOf<String>()
        val valid = mutableListOf<HealthSyncPayloadRecord>()
        val skippedTypes = mutableSetOf<HealthSyncType>()
        var skipped = 0

        records.forEach { source ->
            if (source is HealthSyncRecord.Sleep) return@forEach

            val externalId = source.externalId.trim()
            if (externalId.isEmpty() || externalId.length > MAX_EXTERNAL_ID_LENGTH || !seen.add(externalId)) {
                skipped += 1
                skippedTypes += source.syncType()
                return@forEach
            }

            val payload = when (source) {
                is HealthSyncRecord.Weight -> weight(source, externalId, fallbackZone)
                is HealthSyncRecord.Exercise -> exercise(source, externalId, fallbackZone)
                is HealthSyncRecord.Sleep -> null
            }
            if (payload == null) {
                skipped += 1
                skippedTypes += source.syncType()
            } else {
                valid += payload
            }
        }

        val batches = mutableListOf<HealthSyncPayloadBatch>()
        val current = mutableListOf<EncodedHealthSyncPayloadRecord>()
        var currentBytes = JSON_ARRAY_WRAPPER_BYTES
        valid.forEach { record ->
            val encoded = EncodedHealthSyncPayloadRecord(record, record.toJson())
            val separatorBytes = if (current.isEmpty()) 0 else JSON_SEPARATOR_BYTES
            val candidateBytes = currentBytes + separatorBytes + encoded.utf8Bytes
            if (current.isNotEmpty() &&
                (current.size + 1 > MAX_RECORDS || candidateBytes > MAX_BODY_BYTES)
            ) {
                batches += current.toBatch()
                current.clear()
                currentBytes = JSON_ARRAY_WRAPPER_BYTES
            }
            current += encoded
            currentBytes += if (current.size == 1) 0 else JSON_SEPARATOR_BYTES
            currentBytes += encoded.utf8Bytes
        }
        if (current.isNotEmpty()) batches += current.toBatch()

        return HealthSyncBuildResult(
            batches = batches,
            skippedCount = skipped,
            skippedTypes = skippedTypes,
        )
    }

    private fun weight(
        source: HealthSyncRecord.Weight,
        externalId: String,
        fallbackZone: ZoneId,
    ): HealthSyncPayloadRecord? {
        if (!source.kilograms.isFinite() || source.kilograms <= 0.0) return null
        return HealthSyncPayloadRecord(
            kind = HealthSyncKind.WEIGHT,
            externalId = externalId,
            occurredAt = occurredAt(source.measuredAt, source.zoneOffset, fallbackZone),
            weightKg = source.kilograms,
        )
    }

    private fun exercise(
        source: HealthSyncRecord.Exercise,
        externalId: String,
        fallbackZone: ZoneId,
    ): HealthSyncPayloadRecord? {
        if (hasControlCharacter(source.title)) return null
        val activity = source.title.trim()
        if (activity.isEmpty() || activity.length > MAX_ACTIVITY_LENGTH) return null
        return HealthSyncPayloadRecord(
            kind = HealthSyncKind.EXERCISE,
            externalId = externalId,
            occurredAt = occurredAt(source.startedAt, source.startZoneOffset, fallbackZone),
            activity = activity,
            durationMinutes = validDurationMinutes(source.startedAt, source.endedAt),
        )
    }

    fun occurredAt(instant: Instant, recordedOffset: ZoneOffset?, fallbackZone: ZoneId): String {
        // A null Health Connect offset is resolved locally. OffsetDateTime never emits RFC 3339's
        // unknown -00:00 marker; zero is represented as the known UTC offset Z.
        val offset = recordedOffset ?: fallbackZone.rules.getOffset(instant)
        return OffsetDateTime.ofInstant(instant, offset).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)
    }

    private fun validDurationMinutes(start: Instant, end: Instant): Int? =
        HealthDuration.roundedMinutes(start, end).takeIf { it in 1L..1440L }?.toInt()

    private fun hasControlCharacter(value: String): Boolean = value.any { character ->
        character.code in 0..31 || character.code in 127..159
    }

    private data class EncodedHealthSyncPayloadRecord(
        val record: HealthSyncPayloadRecord,
        val json: String,
    ) {
        val utf8Bytes: Int get() = json.toByteArray(StandardCharsets.UTF_8).size
    }

    private fun List<EncodedHealthSyncPayloadRecord>.toBatch(): HealthSyncPayloadBatch {
        val body = buildString {
            append('[')
            // Qualified because buildString puts a StringBuilder in scope, and an unqualified
            // forEachIndexed there resolves to CharSequence's and iterates characters.
            this@toBatch.forEachIndexed { index, encoded ->
                if (index > 0) append(',')
                append(encoded.json)
            }
            append(']')
        }
        return HealthSyncPayloadBatch(map { it.record }, body)
    }

    private fun HealthSyncRecord.syncType(): HealthSyncType = when (this) {
        is HealthSyncRecord.Weight -> HealthSyncType.WEIGHT
        is HealthSyncRecord.Exercise -> HealthSyncType.EXERCISE
        is HealthSyncRecord.Sleep -> error("sleep records are not sync targets")
    }

    private const val JSON_ARRAY_WRAPPER_BYTES = 2
    private const val JSON_SEPARATOR_BYTES = 1
}

/** Pure mapping/formatting functions stay independent of Android and Health Connect. */
object HealthSummaryFormatter {
    fun weight(
        samples: List<WeightMeasurement>,
        fallbackZone: ZoneId = ZoneId.systemDefault(),
    ): HealthDataSummary {
        val latest = samples.maxByOrNull(WeightMeasurement::measuredAt)
        return HealthDataSummary(
            type = HealthDataType.WEIGHT,
            access = SummaryAccess.GRANTED,
            count = samples.size,
            preview = latest?.let {
                "${formatDateTime(it.measuredAt, it.zoneOffset, fallbackZone)}・${formatNumber(it.kilograms)} kg"
            },
        )
    }

    fun exercise(
        samples: List<ExerciseSession>,
        fallbackZone: ZoneId = ZoneId.systemDefault(),
    ): HealthDataSummary {
        val latest = samples.maxByOrNull(ExerciseSession::startedAt)
        return HealthDataSummary(
            type = HealthDataType.EXERCISE,
            access = SummaryAccess.GRANTED,
            count = samples.size,
            preview = latest?.let {
                "${it.title}・${formatDateTime(it.startedAt, it.startZoneOffset, fallbackZone)}・${formatDuration(it.startedAt, it.endedAt)}"
            },
        )
    }

    fun sleep(
        samples: List<SleepSession>,
        fallbackZone: ZoneId = ZoneId.systemDefault(),
    ): HealthDataSummary {
        val latest = samples.maxByOrNull(SleepSession::startedAt)
        return HealthDataSummary(
            type = HealthDataType.SLEEP,
            access = SummaryAccess.GRANTED,
            count = samples.size,
            preview = latest?.let {
                val title = it.title?.takeIf(String::isNotBlank)?.let { value -> "$value・" }.orEmpty()
                "$title${formatDateTime(it.startedAt, it.startZoneOffset, fallbackZone)}・${formatDuration(it.startedAt, it.endedAt)}"
            },
        )
    }

    fun notGranted(type: HealthDataType): HealthDataSummary =
        HealthDataSummary(type = type, access = SummaryAccess.NOT_GRANTED)

    fun failed(type: HealthDataType, message: String): HealthDataSummary =
        HealthDataSummary(type = type, access = SummaryAccess.READ_FAILED, errorMessage = message)

    fun formatDateTime(
        instant: Instant,
        recordedOffset: ZoneOffset?,
        fallbackZone: ZoneId = ZoneId.systemDefault(),
    ): String {
        // Health Connect leaves offsets nullable. Only use the device zone when the record has none.
        val zone = recordedOffset ?: fallbackZone
        return DateTimeFormatter.ofPattern("M月d日 HH:mm", Locale.JAPAN).withZone(zone).format(instant)
    }

    fun formatDuration(start: Instant, end: Instant): String {
        val minutes = HealthDuration.roundedMinutes(start, end)
        val hours = minutes / 60
        val remainder = minutes % 60
        return when {
            hours > 0 && remainder > 0 -> "${hours}時間${remainder}分"
            hours > 0 -> "${hours}時間"
            else -> "${remainder}分"
        }
    }

    private fun formatNumber(value: Double): String = String.format(Locale.ROOT, "%.1f", value)
}
