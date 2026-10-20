import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionSchema } from "@opencode/core/session/schema"
import type { ServerOptions } from "@opencode/server/options"
import { createHost } from "../host"
import type { Fence, StateBackend } from "../contracts"
import { sharedSqlite } from "./sqlite"
import { externalEvents } from "../events"
import { admissionExecution, initializeControl } from "../control"
import { executionLayers } from "../execution/layers"
import type { Transport } from "../execution/protocol"
import type { LayerNode } from "@opencode/util/effect/layer-node"

export interface Options {
  readonly backend: StateBackend
  readonly namespace: string
  readonly server: ServerOptions
  readonly execution?: Transport
  /** Provider/plugin service overrides use the same embedding contract as upstream. */
  readonly overrides?: LayerNode.Replacements
}

/** Every API replica uses the authoritative backend for every SQL transaction. */
export function createReplica(options: Options) {
  return createHost({ ...options.server, events: { persist: true } }, [
    Database.node.replace(Database.configuredClient(sharedSqlite(options.backend, options.namespace))),
    SessionExecution.node.replace(admissionExecution),
    Bus.node.replace(Bus.configured({ persist: true, external: externalEvents })),
    SessionRestart.node.replace(
      Layer.succeed(SessionRestart.Service, {
        resumeSuspendedSessions: Effect.void,
      }),
    ),
    ...(options.execution ? executionLayers(options.execution) : []),
    ...(options.overrides ?? []),
  ])
}

/**
 * A worker is a pooled OpenCode runtime, not one process per session. Only the
 * execution owner receives a fence; API admission remains available independently.
 */
export async function createWorker(options: Options, fence: Fence) {
  const host = await createHost({ ...options.server, events: { persist: true } }, [
    Database.node.replace(Database.configuredClient(sharedSqlite(options.backend, options.namespace, fence))),
    SessionRestart.node.replace(SessionRestart.configured({ maxAttempts: 0 })),
    Bus.node.replace(Bus.configured({ persist: true, external: externalEvents })),
    ...(options.execution ? executionLayers(options.execution) : []),
    ...(options.overrides ?? []),
  ])
  const execution = Context.get(host.context, SessionExecution.Service)
  const db = Context.get(host.context, Database.Service).db
  await host.runtime.runPromise(initializeControl(db))
  // Do not blindly replay a possibly executed external tool on takeover.
  // A subsequent explicit user prompt can resume from the durable transcript.
  await host.runtime.runPromise(
    db
      .run("DELETE FROM cluster_wake WHERE session_id IN (SELECT id FROM session_v2 WHERE time_suspended IS NOT NULL)")
      .pipe(Effect.orDie),
  )
  await host.runtime.runPromise(Context.get(host.context, SessionRestart.Service).resumeSuspendedSessions)
  return {
    ...host,
    tick: (concurrency: number) =>
      host.runtime.runPromise(
        Effect.gen(function* () {
          const controls = yield* db
            .all<{
              seq: number
              session_id: string
              resume: number
            }>("SELECT * FROM cluster_control ORDER BY seq LIMIT 128")
            .pipe(Effect.orDie)
          for (const control of controls) {
            yield* execution.interrupt(SessionSchema.ID.make(control.session_id), { resume: !!control.resume })
            if (!control.resume)
              yield* db
                .run(`DELETE FROM cluster_wake WHERE session_id = '${control.session_id.replaceAll("'", "''")}'`)
                .pipe(Effect.orDie)
            yield* db.run(`DELETE FROM cluster_control WHERE seq = ${control.seq}`).pipe(Effect.orDie)
          }
          const active = yield* execution.active
          const rows = yield* db
            .all<{ session_id: string; phase: string }>("SELECT * FROM cluster_wake ORDER BY rowid")
            .pipe(Effect.orDie)
          const available = Math.max(0, concurrency - active.size)
          const pending = rows.filter((row) => !active.has(SessionSchema.ID.make(row.session_id))).slice(0, available)
          for (const row of pending) {
            const id = row.session_id.replaceAll("'", "''")
            const inbox = yield* db
              .get<{ total: number }>(`SELECT count(*) AS total FROM session_inbox WHERE session_id = '${id}'`)
              .pipe(Effect.orDie)
            if (!inbox!.total) {
              yield* db.run(`DELETE FROM cluster_wake WHERE session_id = '${id}'`).pipe(Effect.orDie)
              continue
            }
            yield* db.run(`UPDATE cluster_wake SET phase = 'running' WHERE session_id = '${id}'`).pipe(Effect.orDie)
            yield* execution.wake(SessionSchema.ID.make(row.session_id))
          }
          const now = yield* execution.active
          const encoded = JSON.stringify([...now]).replaceAll("'", "''")
          yield* db
            .run(
              `INSERT INTO cluster_runtime (id, active, expires) VALUES (1, '${encoded}', unixepoch('subsec') * 1000 + 5000)
          ON CONFLICT (id) DO UPDATE SET active = excluded.active, expires = excluded.expires`,
            )
            .pipe(Effect.orDie)
        }),
      ),
    active: () => host.runtime.runPromise(execution.active),
  }
}
