package com.tachicoma.lifegame.health

import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.time.Duration
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

data class WeightMeasurement(
    val kilograms: Double,
    val measuredAt: Instant,
)

data class ExerciseSession(
    val name: String,
    val startedAt: Instant,
    val endedAt: Instant,
)

data class SleepSession(
    val startedAt: Instant,
    val endedAt: Instant,
)

data class HealthSnapshot(
    val weights: List<WeightMeasurement> = emptyList(),
    val exercises: List<ExerciseSession> = emptyList(),
    val sleeps: List<SleepSession> = emptyList(),
)

data class HealthPreviewItem(
    val headline: String,
    val supportingText: String,
)

data class HealthPreview(
    val weights: List<HealthPreviewItem> = emptyList(),
    val exercises: List<HealthPreviewItem> = emptyList(),
    val sleeps: List<HealthPreviewItem> = emptyList(),
)

class HealthPreviewFormatter(
    private val zoneId: ZoneId,
) {
    private val dateTimeFormatter =
        DateTimeFormatter.ofPattern("M月d日 H:mm", Locale.JAPAN).withZone(zoneId)
    private val timeFormatter =
        DateTimeFormatter.ofPattern("H:mm", Locale.JAPAN).withZone(zoneId)

    fun format(snapshot: HealthSnapshot): HealthPreview =
        HealthPreview(
            weights = snapshot.weights.map { measurement ->
                HealthPreviewItem(
                    headline = "${measurement.kilograms.toDisplayKilograms()} kg",
                    supportingText = dateTimeFormatter.format(measurement.measuredAt),
                )
            },
            exercises = snapshot.exercises.map { session ->
                val durationMinutes = Duration.between(session.startedAt, session.endedAt).toMinutes()
                HealthPreviewItem(
                    headline = session.name,
                    supportingText =
                        "${dateTimeFormatter.format(session.startedAt)}〜" +
                            "${timeFormatter.format(session.endedAt)}（${durationMinutes}分）",
                )
            },
            sleeps = snapshot.sleeps.map { session ->
                val durationMinutes = Duration.between(session.startedAt, session.endedAt).toMinutes()
                val hours = durationMinutes / 60
                val minutes = durationMinutes % 60
                val duration =
                    if (minutes == 0L) "${hours}時間" else "${hours}時間${minutes}分"
                HealthPreviewItem(
                    headline = duration,
                    supportingText =
                        "${dateTimeFormatter.format(session.startedAt)}〜" +
                            dateTimeFormatter.format(session.endedAt),
                )
            },
        )

    private fun Double.toDisplayKilograms(): String =
        BigDecimal.valueOf(this).setScale(1, RoundingMode.HALF_UP).toPlainString()
}
