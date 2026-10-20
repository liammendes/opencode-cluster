import { Effect, Layer } from "effect"
import { Database } from "@opencode/core/database/database"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionSchema } from "@opencode/core/session/schema"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export const initializeControl = Effect.fn(function* (db: Database.Interface["db"]) {
  yield* db
    .run(
      `CREATE TABLE IF NOT EXISTS cluster_control (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, resume INTEGER NOT NULL
  )`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      `CREATE TABLE IF NOT EXISTS cluster_assignments (
        session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, epoch INTEGER NOT NULL
      )`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      `CREATE TABLE IF NOT EXISTS cluster_worker_runtime (
        owner TEXT PRIMARY KEY, epoch INTEGER NOT NULL, active TEXT NOT NULL,
        roots INTEGER NOT NULL, capacity INTEGER NOT NULL, cpu REAL NOT NULL,
        memory REAL NOT NULL, expires INTEGER NOT NULL
      )`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      `CREATE TABLE IF NOT EXISTS cluster_scaling (
        id INTEGER PRIMARY KEY CHECK (id = 1), pause_until INTEGER NOT NULL DEFAULT 0
      )`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      `CREATE TABLE IF NOT EXISTS cluster_runtime (
    id INTEGER PRIMARY KEY CHECK (id = 1), active TEXT NOT NULL, expires INTEGER NOT NULL
  )`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      `CREATE TABLE IF NOT EXISTS cluster_wake (
    session_id TEXT PRIMARY KEY, phase TEXT NOT NULL DEFAULT 'pending'
  )`,
    )
    .pipe(Effect.orDie)
})

export const admissionExecution = makeGlobalNode({
  service: SessionExecution.Service,
  deps: [Database.node],
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* initializeControl(db)
      const active = db
        .all<{
          active: string
        }>(
          `SELECT active FROM cluster_runtime WHERE id = 1 AND expires > unixepoch('subsec') * 1000
           UNION ALL SELECT active FROM cluster_worker_runtime WHERE expires > unixepoch('subsec') * 1000`,
        )
        .pipe(
          Effect.orDie,
          Effect.map(
            (rows) =>
              new Set(rows.flatMap((row) => JSON.parse(row.active) as string[]).map((id) => SessionSchema.ID.make(id))),
          ),
        )
      return SessionExecution.Service.of({
        active,
        isActive: (id) => active.pipe(Effect.map((sessions) => sessions.has(id))),
        wake: (id) =>
          db
            .run(
              `INSERT INTO cluster_wake (session_id) VALUES ('${id.replaceAll("'", "''")}')
        ON CONFLICT (session_id) DO UPDATE SET phase = 'pending'`,
            )
            .pipe(Effect.orDie, Effect.asVoid),
        resume: () => Effect.die("Synchronous execution is unavailable on an API replica; submit a prompt"),
        awaitIdle: Effect.fn("ClusterExecution.awaitIdle")(function* (id) {
          // A lost heartbeat does not prove settlement. Only the worker's terminal
          // commit (or restart recovery) releases this durable execution claim.
          while (true) {
            const row = yield* db
              .get<{
                time_suspended: number | null
              }>(`SELECT time_suspended FROM session_v2 WHERE id = '${id.replaceAll("'", "''")}'`)
              .pipe(Effect.orDie)
            if (row?.time_suspended == null) return
            yield* Effect.sleep("250 millis")
          }
        }),
        interrupt: (id, options) =>
          Effect.gen(function* () {
            const sessions = yield* active
            if (!sessions.has(id)) return false
            // Schema-branded IDs still need SQL string escaping.
            yield* db
              .run(
                `INSERT INTO cluster_control (session_id, resume) VALUES ('${id.replaceAll("'", "''")}', ${options?.resume ? 1 : 0})`,
              )
              .pipe(Effect.orDie)
            return true
          }),
      })
    }),
  ),
})
