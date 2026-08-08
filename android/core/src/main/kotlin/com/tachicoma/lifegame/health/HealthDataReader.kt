package com.tachicoma.lifegame.health

import java.time.Duration
import java.time.Instant

enum class HealthDataType(val displayName: String) {
    WEIGHT("体重"),
    EXERCISE("運動"),
    SLEEP("睡眠"),
}

data class HealthReadWindow(
    val startedAt: Instant,
    val endedAt: Instant,
) {
    companion object {
        fun last30Days(endingAt: Instant): HealthReadWindow =
            HealthReadWindow(
                startedAt = endingAt.minus(Duration.ofDays(30)),
                endedAt = endingAt,
            )
    }
}

interface HealthDataReader {
    suspend fun read(
        allowedTypes: Set<HealthDataType>,
        window: HealthReadWindow,
    ): HealthSnapshot
}
