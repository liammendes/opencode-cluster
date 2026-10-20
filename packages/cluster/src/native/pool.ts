import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { SessionExecution } from "@opencode/core/session/execution"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionStore } from "@opencode/core/session/store"
import { Instance } from "@opencode/core/instance/service"
import { Job } from "@opencode/core/job"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionSchema } from "@opencode/core/session/schema"
import { createHost } from "../host"
import { initializeControl } from "../control"
import { externalEvents } from "../events"
import { executionLayers } from "../execution/layers"
import { sharedSqlite } from "./sqlite"
import { FencedError, type Fence, type WorkerStateBackend } from "../contracts"
import type { Options } from "./server"

type DB = Database.Interface["db"]
type Assignment = { session_id: string; owner: string; epoch: number }
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`
const rootQuery = (id: string) => `
  WITH RECURSIVE parents(id, parent_id) AS (
    SELECT id, parent_id FROM session_v2 WHERE id = ${quoted(id)}
    UNION ALL SELECT s.id, s.parent_id FROM session_v2 s JOIN parents p ON p.parent_id = s.id
  ) SELECT id FROM parents WHERE parent_id IS NULL`
const treeQuery = (id: string) => `
  WITH RECURSIVE tree(id) AS (
    SELECT id FROM session_v2 WHERE id = ${quoted(id)}
    UNION ALL SELECT s.id FROM session_v2 s JOIN tree t ON s.parent_id = t.id
  ) SELECT id FROM tree`

const claim = (db: DB, fence: Fence, capacity: number, id: SessionSchema.ID) =>
  db
    .transaction(() =>
      Effect.gen(function* () {
        const root = yield* db.get<{ id: string }>(rootQuery(id))
        if (!root) return false
        const existing = yield* db.get<Assignment>(
          `SELECT * FROM cluster_assignments WHERE session_id = ${quoted(root.id)}`,
        )
        if (existing) return existing.owner === fence.owner && existing.epoch === fence.epoch
        const paused = yield* db.get(
          "SELECT id FROM cluster_scaling WHERE id = 1 AND pause_until > unixepoch('subsec') * 1000",
        )
        if (paused) return false
        const owned = yield* db.get<{ total: number }>(
          `SELECT count(*) AS total FROM cluster_assignments
         WHERE owner = ${quoted(fence.owner)} AND epoch = ${fence.epoch}`,
        )
        if ((owned?.total ?? 0) >= capacity) return false
        yield* db.run(
          `INSERT INTO cluster_assignments (session_id, owner, epoch)
         VALUES (${quoted(root.id)}, ${quoted(fence.owner)}, ${fence.epoch})`,
        )
        return true
      }),
    )
    .pipe(Effect.orDie)

/** Descendants stay with their root's owner, including synchronous subagent calls. */
function distributedExecution(fence: Fence, capacity: number) {
  return makeGlobalNode({
    service: SessionExecution.Service,
    deps: [SessionStore.node, Instance.node, Bus.node, Database.node, Job.node],
    layer: Layer.effect(
      SessionExecution.Service,
      Effect.gen(function* () {
        const local = yield* SessionExecution.Service
        const db = (yield* Database.Service).db
        yield* initializeControl(db)
        return SessionExecution.Service.of({
          ...local,
          wake: Effect.fn("ClusterPool.wake")(function* (id) {
            if (yield* claim(db, fence, capacity, id)) yield* local.wake(id)
          }),
          resume: Effect.fn("ClusterPool.resume")(function* (id) {
            if (!(yield* claim(db, fence, capacity, id)))
              return yield* Effect.die("Session execution belongs to another worker or the worker is at capacity")
            yield* local.resume(id)
          }),
        })
      }),
    ).pipe(Layer.provide(SessionExecution.layer)),
  })
}

export interface Utilization {
  cpu: number
  memory: number
}

/** Shared state is authoritative; process leases and root claims have separate jobs. */
export async function createPoolWorker(
  options: Options & { backend: WorkerStateBackend },
  fence: Fence,
  capacity: number,
) {
  if (fence.scope !== "worker") throw new Error("A distributed worker lease is required")
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Worker capacity must be positive")
  const transport = options.execution
  const recoveryIDs = new Set<SessionSchema.ID>()
  const host = await createHost({ ...options.server, events: { persist: true } }, [
    Database.node.replace(Database.configuredClient(sharedSqlite(options.backend, options.namespace, fence))),
    SessionExecution.node.replace(distributedExecution(fence, capacity)),
    SessionRestart.node.replace(SessionRestart.configured({ maxAttempts: 0, sessionIDs: recoveryIDs })),
    Bus.node.replace(Bus.configured({ persist: true, external: externalEvents })),
    ...(transport
      ? executionLayers(async (request) => {
          // Reject new external commands after ownership loss. Cancellation of
          // commands already started must remain possible during cleanup.
          if (new URL(request.url).pathname === "/process" && request.method === "POST")
            if (!(await options.backend.alive(fence))) throw new FencedError()
          return transport(request)
        })
      : []),
    ...(options.overrides ?? []),
  ])
  const execution = Context.get(host.context, SessionExecution.Service)
  const db = Context.get(host.context, Database.Service).db
  const restart = Context.get(host.context, SessionRestart.Service)
  const run = <A, E>(effect: Effect.Effect<A, E>) => host.runtime.runPromise(effect)
  const owned = () =>
    db
      .all<Assignment>(
        `SELECT * FROM cluster_assignments WHERE owner = ${quoted(fence.owner)} AND epoch = ${fence.epoch}`,
      )
      .pipe(Effect.orDie)

  const recover = async () => {
    const rows = await run(
      db
        .all<Assignment>(
          `SELECT * FROM cluster_assignments WHERE owner <> ${quoted(fence.owner)} OR epoch <> ${fence.epoch}`,
        )
        .pipe(Effect.orDie),
    )
    const checked = new Map<string, boolean>()
    for (const row of rows) {
      const key = `${row.owner}:${row.epoch}`
      let live = checked.get(key)
      if (live === undefined) {
        live = await options.backend.alive({ ...fence, owner: row.owner, epoch: row.epoch })
        checked.set(key, live)
      }
      if (live) continue
      const family = await run(
        db
          .transaction(() =>
            Effect.gen(function* () {
              const taken = yield* db.get<{ session_id: string }>(
                `UPDATE cluster_assignments SET owner = ${quoted(fence.owner)}, epoch = ${fence.epoch}
               WHERE session_id = ${quoted(row.session_id)} AND owner = ${quoted(row.owner)} AND epoch = ${row.epoch}
               RETURNING session_id`,
              )
              if (!taken) return []
              yield* db.run(`DELETE FROM cluster_wake WHERE session_id IN (
              SELECT id FROM session_v2 WHERE time_suspended IS NOT NULL AND id IN (${treeQuery(row.session_id)})
            )`)
              return yield* db.all<{ id: string }>(treeQuery(row.session_id))
            }),
          )
          .pipe(Effect.orDie),
      )
      // Reuse upstream's durable background-job notices, limited to this family.
      // maxAttempts=0 reports uncertain executions instead of replaying tools.
      for (const session of family) recoveryIDs.add(SessionSchema.ID.make(session.id))
      try {
        await run(restart.resumeSuspendedSessions)
      } finally {
        recoveryIDs.clear()
      }
    }
  }

  return {
    ...host,
    active: () => run(execution.active),
    async tick(utilization: Utilization = { cpu: 0, memory: 0 }, admit = true) {
      if (![utilization.cpu, utilization.memory].every((value) => Number.isFinite(value) && value >= 0))
        throw new Error("Worker utilization must contain non-negative finite values")
      await recover()
      await run(
        Effect.gen(function* () {
          const active = yield* execution.active
          const roots = new Set<string>()
          for (const id of active) {
            const root = yield* db.get<{ id: string }>(rootQuery(id)).pipe(Effect.orDie)
            if (root) roots.add(root.id)
          }
          for (const row of yield* owned()) {
            if (roots.has(row.session_id)) continue
            const busy = yield* db
              .get(
                `SELECT id FROM session_v2 WHERE time_suspended IS NOT NULL AND id IN (${treeQuery(row.session_id)})
               UNION ALL SELECT key AS id FROM kv WHERE key LIKE 'job.background/%' AND
                 coalesce(json_extract(value, '$.recovery.sessionID'), json_extract(value, '$.recovery.parentSessionID'))
                 IN (${treeQuery(row.session_id)}) LIMIT 1`,
              )
              .pipe(Effect.orDie)
            if (!busy)
              yield* db
                .run(`DELETE FROM cluster_assignments WHERE session_id = ${quoted(row.session_id)}`)
                .pipe(Effect.orDie)
          }
          const controls = yield* db
            .all<{
              seq: number
              session_id: string
              resume: number
            }>("SELECT * FROM cluster_control ORDER BY seq LIMIT 128")
            .pipe(Effect.orDie)
          for (const control of controls) {
            const root = yield* db.get<{ id: string }>(rootQuery(control.session_id)).pipe(Effect.orDie)
            const owner = root
              ? yield* db
                  .get<Assignment>(`SELECT * FROM cluster_assignments WHERE session_id = ${quoted(root.id)}`)
                  .pipe(Effect.orDie)
              : undefined
            if (owner && (owner.owner !== fence.owner || owner.epoch !== fence.epoch)) continue
            yield* execution.interrupt(SessionSchema.ID.make(control.session_id), { resume: !!control.resume })
            if (!control.resume)
              yield* db
                .run(`DELETE FROM cluster_wake WHERE session_id = ${quoted(control.session_id)}`)
                .pipe(Effect.orDie)
            yield* db.run(`DELETE FROM cluster_control WHERE seq = ${control.seq}`).pipe(Effect.orDie)
          }
          if (admit) {
            const pending = yield* db
              .all<{ session_id: string }>(
                `SELECT session_id FROM cluster_wake
               WHERE session_id IN (SELECT session_id FROM session_inbox) ORDER BY rowid LIMIT 128`,
              )
              .pipe(Effect.orDie)
            for (const row of pending) {
              if (active.has(SessionSchema.ID.make(row.session_id))) continue
              yield* execution.wake(SessionSchema.ID.make(row.session_id))
            }
          }
          const now = yield* execution.active
          const assignments = yield* owned()
          yield* db
            .run(
              `INSERT INTO cluster_worker_runtime (owner, epoch, active, roots, capacity, cpu, memory, expires)
             VALUES (${quoted(fence.owner)}, ${fence.epoch}, ${quoted(JSON.stringify([...now]))},
               ${assignments.length}, ${capacity}, ${utilization.cpu}, ${utilization.memory},
               unixepoch('subsec') * 1000 + 30000)
             ON CONFLICT (owner) DO UPDATE SET epoch = excluded.epoch, active = excluded.active,
               roots = excluded.roots, capacity = excluded.capacity, cpu = excluded.cpu,
               memory = excluded.memory, expires = excluded.expires`,
            )
            .pipe(Effect.orDie)
        }),
      )
    },
  }
}
