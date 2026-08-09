package com.tachicoma.lifegame.companion

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
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
 * The rationale screen only repeats the three points below, so that editing the details of the
 * full text never leaves the on-device wording saying something different. Both the rationale
 * screen and the main screen open the same URL.
 */
object PrivacyPolicy {
    const val URL = "https://lifegame.tachicoma.com/privacy"

    val summary: List<String> = listOf(
        "読み取るのは体重測定・運動実績・睡眠実績の3種類だけです。",
        "読み取った内容を端末の外へ送信しません。",
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
)

data class ExerciseSession(
    val startedAt: Instant,
    val endedAt: Instant,
    val startZoneOffset: ZoneOffset?,
    val endZoneOffset: ZoneOffset?,
    val title: String,
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
)

object HealthReadWindow {
    const val DAYS = 30L

    fun start(now: Instant): Instant = now.minus(Duration.ofDays(DAYS))
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
        val minutes = Duration.between(start, end).toMinutes().coerceAtLeast(0)
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
