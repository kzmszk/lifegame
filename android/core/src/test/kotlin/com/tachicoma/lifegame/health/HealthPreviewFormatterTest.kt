package com.tachicoma.lifegame.health

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class HealthPreviewFormatterTest {
    @Test
    fun `体重測定を利用者の現地日時と小数1桁で表示する`() {
        val snapshot = HealthSnapshot(
            weights = listOf(
                WeightMeasurement(
                    kilograms = 72.35,
                    measuredAt = Instant.parse("2026-08-06T22:30:00Z"),
                ),
            ),
        )

        val preview = HealthPreviewFormatter(ZoneId.of("Asia/Tokyo")).format(snapshot)

        assertEquals(
            listOf(HealthPreviewItem("72.4 kg", "8月7日 7:30")),
            preview.weights,
        )
    }

    @Test
    fun `運動実績を種目と実施時間で表示する`() {
        val snapshot = HealthSnapshot(
            exercises = listOf(
                ExerciseSession(
                    name = "ランニング",
                    startedAt = Instant.parse("2026-08-06T22:00:00Z"),
                    endedAt = Instant.parse("2026-08-06T22:45:00Z"),
                ),
            ),
        )

        val preview = HealthPreviewFormatter(ZoneId.of("Asia/Tokyo")).format(snapshot)

        assertEquals(
            listOf(HealthPreviewItem("ランニング", "8月7日 7:00〜7:45（45分）")),
            preview.exercises,
        )
    }

    @Test
    fun `睡眠実績を日付をまたぐ時間帯と長さで表示する`() {
        val snapshot = HealthSnapshot(
            sleeps = listOf(
                SleepSession(
                    startedAt = Instant.parse("2026-08-06T14:00:00Z"),
                    endedAt = Instant.parse("2026-08-06T22:00:00Z"),
                ),
            ),
        )

        val preview = HealthPreviewFormatter(ZoneId.of("Asia/Tokyo")).format(snapshot)

        assertEquals(
            listOf(HealthPreviewItem("8時間", "8月6日 23:00〜8月7日 7:00")),
            preview.sleeps,
        )
    }
}
