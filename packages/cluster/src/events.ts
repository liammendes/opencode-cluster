import { Effect, Stream } from "effect"
import { Bus } from "@opencode/core/bus"
import type { Event } from "@opencode/schema/event"
import type { Database } from "@opencode/core/database/database"

/** A monotonically increasing outbox survives deletes and timestamp collisions. */
export const externalEvents = Effect.fn(function* (db: Database.Interface["db"]) {
  yield* db
    .run(
      `CREATE TABLE IF NOT EXISTS cluster_event_outbox (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, aggregate_id TEXT NOT NULL,
    seq INTEGER NOT NULL, created INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
  )`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      `CREATE TRIGGER IF NOT EXISTS cluster_event_append AFTER INSERT ON event BEGIN
    INSERT INTO cluster_event_outbox (id, aggregate_id, seq, created, type, data)
    VALUES (NEW.id, NEW.aggregate_id, NEW.seq, NEW.created, NEW.type, NEW.data);
  END`,
    )
    .pipe(Effect.orDie)
  const initial = yield* db
    .get<{ cursor: number }>("SELECT coalesce(max(cursor), 0) AS cursor FROM cluster_event_outbox")
    .pipe(Effect.orDie)
  let cursor = initial!.cursor
  const read = Effect.gen(function* () {
    const rows = yield* db
      .all<{
        cursor: number
        id: Event.ID
        aggregate_id: string
        seq: number
        created: number
        type: string
        data: string
      }>(`SELECT * FROM cluster_event_outbox WHERE cursor > ${cursor} ORDER BY cursor LIMIT 512`)
      .pipe(Effect.orDie)
    cursor = rows.at(-1)?.cursor ?? cursor
    return rows.map((row) =>
      Bus.decodeSerializedEvent({
        id: row.id,
        aggregateID: row.aggregate_id,
        seq: row.seq,
        created: row.created,
        type: row.type,
        data: JSON.parse(row.data) as Record<string, unknown>,
      }),
    )
  })
  return Stream.tick("250 millis").pipe(
    Stream.mapEffect(() => read),
    Stream.flattenIterable,
  )
})
