package com.tachicoma.lifegame.companion

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The only Health Connect permissions this prototype can declare or request. */
object HealthPermissions {
    const val READ_WEIGHT = "android.permission.health.READ_WEIGHT"
    const val READ_EXERCISE = "android.permission.health.READ_EXERCISE"
    const val READ_SLEEP = "android.permission.health.READ_SLEEP"

    val all: Set<String> = setOf(READ_WEIGHT, READ_EXERCISE, READ_SLEEP)
}

enum class HealthDataType(
    val label: String,
    val permission: String,
) {
    WEIGHT("体重測定", HealthPermissions.READ_WEIGHT),
    EXERCISE("運動実績", HealthPermissions.READ_EXERCISE),
    SLEEP("睡眠", HealthPermissions.READ_SLEEP),
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

data class WeightSample(
    val measuredAt: Instant,
    val kilograms: Double,
)

data class ExerciseSample(
    val startedAt: Instant,
    val endedAt: Instant,
    val title: String,
)

data class SleepSample(
    val startedAt: Instant,
    val endedAt: Instant,
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
    fun weight(samples: List<WeightSample>, zone: ZoneId = ZoneId.systemDefault()): HealthDataSummary {
        val latest = samples.maxByOrNull(WeightSample::measuredAt)
        return HealthDataSummary(
            type = HealthDataType.WEIGHT,
            access = SummaryAccess.GRANTED,
            count = samples.size,
            preview = latest?.let {
                "${formatDateTime(it.measuredAt, zone)}・${formatNumber(it.kilograms)} kg"
            },
        )
    }

    fun exercise(
        samples: List<ExerciseSample>,
        zone: ZoneId = ZoneId.systemDefault(),
    ): HealthDataSummary {
        val latest = samples.maxByOrNull(ExerciseSample::startedAt)
        return HealthDataSummary(
            type = HealthDataType.EXERCISE,
            access = SummaryAccess.GRANTED,
            count = samples.size,
            preview = latest?.let {
                "${it.title}・${formatDateTime(it.startedAt, zone)}・${formatDuration(it.startedAt, it.endedAt)}"
            },
        )
    }

    fun sleep(samples: List<SleepSample>, zone: ZoneId = ZoneId.systemDefault()): HealthDataSummary {
        val latest = samples.maxByOrNull(SleepSample::startedAt)
        return HealthDataSummary(
            type = HealthDataType.SLEEP,
            access = SummaryAccess.GRANTED,
            count = samples.size,
            preview = latest?.let {
                val title = it.title?.takeIf(String::isNotBlank)?.let { value -> "$value・" }.orEmpty()
                "$title${formatDateTime(it.startedAt, zone)}・${formatDuration(it.startedAt, it.endedAt)}"
            },
        )
    }

    fun notGranted(type: HealthDataType): HealthDataSummary =
        HealthDataSummary(type = type, access = SummaryAccess.NOT_GRANTED)

    fun failed(type: HealthDataType, message: String): HealthDataSummary =
        HealthDataSummary(type = type, access = SummaryAccess.READ_FAILED, errorMessage = message)

    fun formatDateTime(instant: Instant, zone: ZoneId): String =
        DateTimeFormatter.ofPattern("M月d日 HH:mm", Locale.JAPAN).withZone(zone).format(instant)

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
