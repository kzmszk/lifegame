package com.tachicoma.lifegame.companion

import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HealthSyncPayloadTest {
    private val zone = ZoneId.of("Asia/Tokyo")
    private val instant = Instant.parse("2026-08-10T00:00:00Z")

    @Test
    fun `sleep records never appear in the payload`() {
        val result = HealthSyncPayloadBuilder.build(
            listOf(
                HealthSyncRecord.Sleep("sleep-1", instant, instant.plusSeconds(3600), "睡眠"),
                weight("weight-1"),
            ),
            zone,
        )

        assertEquals(1, result.sentCount)
        assertEquals(0, result.skippedCount)
        assertFalse(result.batches.single().body.contains("sleep"))
        assertFalse(result.batches.single().body.contains("睡眠"))
    }

    @Test
    fun `payload fields are exclusive to their record kind`() {
        val body = HealthSyncPayloadBuilder.build(
            listOf(
                weight("weight-1"),
                exercise("exercise-1", end = instant.plusSeconds(32 * 60L)),
            ),
            zone,
        ).batches.single().body

        val weightJson = body.substringAfter("{\"kind\":\"weight\"").substringBefore('}')
        val exerciseJson = body.substringAfter("{\"kind\":\"exercise\"").substringBefore('}')
        assertTrue(weightJson.contains("weight_kg"))
        assertFalse(weightJson.contains("activity"))
        assertFalse(weightJson.contains("duration_minutes"))
        assertTrue(exerciseJson.contains("activity"))
        assertTrue(exerciseJson.contains("duration_minutes"))
        assertFalse(exerciseJson.contains("weight_kg"))
    }

    @Test
    fun `missing offset is resolved using the device zone and never becomes unknown offset`() {
        val payload = HealthSyncPayloadBuilder.build(listOf(weight("weight-1", null)), zone)
            .batches.single().records.single()

        assertEquals("2026-08-10T09:00:00+09:00", payload.occurredAt)
        assertFalse(payload.occurredAt.contains("-00:00"))
    }

    @Test
    fun `records split at both the count and byte limits`() {
        val countSplit = HealthSyncPayloadBuilder.build(
            (0 until 501).map { weight("weight-$it") },
            zone,
        )
        assertEquals(listOf(500, 1), countSplit.batches.map { it.records.size })

        val byteSplit = HealthSyncPayloadBuilder.build(
            (0 until 500).map { index ->
                HealthSyncRecord.Exercise(
                    externalId = "運動-${index.toString().padStart(4, '0')}-" + "あ".repeat(248),
                    startedAt = instant.plusSeconds(index.toLong()),
                    endedAt = instant.plusSeconds(index.toLong() + 32 * 60L),
                    startZoneOffset = ZoneOffset.ofHours(9),
                    title = "運".repeat(200),
                )
            },
            zone,
        )
        assertTrue(byteSplit.batches.size > 1)
        assertTrue(byteSplit.batches.all { it.bodyBytes <= HealthSyncPayloadBuilder.MAX_BODY_BYTES })
    }

    @Test
    fun `duplicate external ids are sent once`() {
        val result = HealthSyncPayloadBuilder.build(
            listOf(weight(" same-id "), weight("same-id"), weight("other-id")),
            zone,
        )

        assertEquals(2, result.sentCount)
        assertEquals(1, result.skippedCount)
        assertEquals(setOf(HealthSyncType.WEIGHT), result.skippedTypes)
        assertEquals(2, result.batches.single().records.map { it.externalId }.toSet().size)
    }

    @Test
    fun `duration is rounded to nearest minute and overlong activity is not sent`() {
        val result = HealthSyncPayloadBuilder.build(
            listOf(
                exercise("short", end = instant.plusSeconds(90)),
                exercise("long-duration", end = instant.plusSeconds(1450 * 60L)),
                exercise("fractional", end = instant.plusSeconds(32 * 60L + 1)),
                exercise("under-one-minute", end = instant.plusSeconds(29)),
                exercise("half-minute", end = instant.plusSeconds(30)),
                exercise("control-character", title = "\nランニング"),
                exercise("overlong", title = "あ".repeat(201)),
            ),
            zone,
        )

        assertEquals(5, result.sentCount)
        assertEquals(2, result.skippedCount)
        val body = result.batches.single().body
        assertTrue(body.contains("short"))
        assertTrue(body.contains("long-duration"))
        assertTrue(body.contains("fractional"))
        assertTrue(body.contains("under-one-minute"))
        assertTrue(body.contains("half-minute"))
        assertFalse(body.contains("control-character"))
        assertFalse(body.contains("overlong"))
        assertEquals(2, result.batches.single().records.first { it.externalId == "short" }.durationMinutes)
        assertEquals(32, result.batches.single().records.first { it.externalId == "fractional" }.durationMinutes)
        assertEquals(null, result.batches.single().records.first { it.externalId == "under-one-minute" }.durationMinutes)
        assertEquals(1, result.batches.single().records.first { it.externalId == "half-minute" }.durationMinutes)
        assertEquals(null, result.batches.single().records.first { it.externalId == "long-duration" }.durationMinutes)
    }

    @Test
    fun `invalid records hold only their own changes token`() {
        val result = HealthSyncPayloadBuilder.build(
            listOf(
                weight("invalid-weight", offset = ZoneOffset.UTC).copy(kilograms = -1.0),
                exercise("valid-exercise"),
            ),
            zone,
        )

        assertEquals(setOf(HealthSyncType.WEIGHT), result.skippedTypes)
        assertEquals(
            mapOf(HealthSyncType.EXERCISE to "exercise-next"),
            HealthSyncTokenPolicy.tokensToSave(
                mapOf(
                    HealthSyncType.WEIGHT to "weight-next",
                    HealthSyncType.EXERCISE to "exercise-next",
                ),
                result.skippedTypes,
            ),
        )
    }

    @Test
    fun `a permission denied type is excluded before payload construction`() {
        val weights = listOf(
            WeightMeasurement(instant, ZoneOffset.UTC, 68.4, "weight-1"),
        )
        val exercises = listOf(
            ExerciseSession(instant, instant.plusSeconds(60), ZoneOffset.UTC, ZoneOffset.UTC, "歩行", "exercise-1"),
        )

        val records = HealthSyncSelection.forGrantedPermissions(
            grantedPermissions = setOf(HealthPermissions.READ_WEIGHT),
            weights = weights,
            exercises = exercises,
        )

        assertEquals(listOf("weight-1"), records.map { it.externalId })
    }

    private fun weight(id: String, offset: ZoneOffset? = ZoneOffset.ofHours(9)) =
        HealthSyncRecord.Weight(id, instant, offset, 68.4)

    private fun exercise(
        id: String,
        end: Instant = instant.plusSeconds(32 * 60L),
        title: String = "ランニング",
    ) = HealthSyncRecord.Exercise(id, instant, end, ZoneOffset.ofHours(9), title)
}
