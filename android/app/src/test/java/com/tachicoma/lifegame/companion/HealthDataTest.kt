package com.tachicoma.lifegame.companion

import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HealthDataTest {
    private val zone = ZoneId.of("Asia/Tokyo")

    @Test
    fun `only the three read permissions are requested`() {
        assertEquals(
            setOf(
                "android.permission.health.READ_WEIGHT",
                "android.permission.health.READ_EXERCISE",
                "android.permission.health.READ_SLEEP",
            ),
            HealthPermissions.all,
        )
    }

    @Test
    fun `weight summary shows latest measurement and count`() {
        val summary = HealthSummaryFormatter.weight(
            listOf(
                WeightMeasurement(
                    measuredAt = Instant.parse("2026-08-01T23:00:00Z"),
                    zoneOffset = ZoneOffset.ofHours(9),
                    kilograms = 70.25,
                ),
                WeightMeasurement(
                    measuredAt = Instant.parse("2026-08-02T23:00:00Z"),
                    zoneOffset = ZoneOffset.ofHours(9),
                    kilograms = 69.8,
                ),
            ),
            zone,
        )

        assertEquals(SummaryAccess.GRANTED, summary.access)
        assertEquals(2, summary.count)
        assertEquals("8月3日 08:00・69.8 kg", summary.preview)
    }

    @Test
    fun `exercise summary formats duration`() {
        val summary = HealthSummaryFormatter.exercise(
            listOf(
                ExerciseSession(
                    startedAt = Instant.parse("2026-08-04T01:00:00Z"),
                    endedAt = Instant.parse("2026-08-04T02:35:00Z"),
                    startZoneOffset = ZoneOffset.ofHours(9),
                    endZoneOffset = ZoneOffset.ofHours(9),
                    title = "ウォーキング",
                ),
            ),
            zone,
        )

        assertEquals("ウォーキング・8月4日 10:00・1時間35分", summary.preview)
    }

    @Test
    fun `sleep without title still has a representative item`() {
        val summary = HealthSummaryFormatter.sleep(
            listOf(
                SleepSession(
                    startedAt = Instant.parse("2026-08-04T14:00:00Z"),
                    endedAt = Instant.parse("2026-08-04T21:30:00Z"),
                    startZoneOffset = ZoneOffset.ofHours(9),
                    endZoneOffset = ZoneOffset.ofHours(9),
                    title = null,
                ),
            ),
            zone,
        )

        assertEquals("8月4日 23:00・7時間30分", summary.preview)
    }

    @Test
    fun `granted but empty data is represented without a fake preview`() {
        val summary = HealthSummaryFormatter.weight(emptyList(), zone)

        assertEquals(SummaryAccess.GRANTED, summary.access)
        assertEquals(0, summary.count)
        assertNull(summary.preview)
    }

    @Test
    fun `permission denial is kept separate from empty data`() {
        val summary = HealthSummaryFormatter.notGranted(HealthDataType.SLEEP)

        assertEquals(SummaryAccess.NOT_GRANTED, summary.access)
        assertEquals(0, summary.count)
        assertTrue(summary.preview == null)
    }

    @Test
    fun `record offset wins when device timezone differs`() {
        val summary = HealthSummaryFormatter.weight(
            listOf(
                WeightMeasurement(
                    measuredAt = Instant.parse("2026-08-04T01:00:00Z"),
                    zoneOffset = ZoneOffset.ofHours(-7),
                    kilograms = 69.8,
                ),
            ),
            zone,
        )

        assertEquals("8月3日 18:00・69.8 kg", summary.preview)
    }

    @Test
    fun `missing record offset uses the explicit device timezone fallback`() {
        val summary = HealthSummaryFormatter.sleep(
            listOf(
                SleepSession(
                    startedAt = Instant.parse("2026-08-04T01:00:00Z"),
                    endedAt = Instant.parse("2026-08-04T02:00:00Z"),
                    startZoneOffset = null,
                    endZoneOffset = null,
                    title = null,
                ),
            ),
            zone,
        )

        assertEquals("8月4日 10:00・1時間", summary.preview)
    }

    @Test
    fun `read window is exactly the last thirty days`() {
        val now = Instant.parse("2026-08-07T00:00:00Z")

        assertEquals(Instant.parse("2026-07-08T00:00:00Z"), HealthReadWindow.start(now))
    }
}
