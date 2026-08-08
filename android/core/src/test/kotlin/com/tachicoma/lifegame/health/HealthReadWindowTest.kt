package com.tachicoma.lifegame.health

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Test

class HealthReadWindowTest {
    @Test
    fun `直近30日は終了時刻から30日前に始まる`() {
        val window = HealthReadWindow.last30Days(
            endingAt = Instant.parse("2026-08-07T03:00:00Z"),
        )

        assertEquals(
            HealthReadWindow(
                startedAt = Instant.parse("2026-07-08T03:00:00Z"),
                endedAt = Instant.parse("2026-08-07T03:00:00Z"),
            ),
            window,
        )
    }
}
