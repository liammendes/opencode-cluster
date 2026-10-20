import { Database } from "bun:sqlite"
import type { StateBackend } from "../contracts"
import { defaultLimits, scale, type CapacityProvider, type ScalingLimits, type WorkerMetrics } from "../scaling"
import type { Transport } from "../execution/protocol"

export function createScaler(
  backend: StateBackend,
  namespace: string,
  provider: CapacityProvider,
  execution: Transport,
  limits: ScalingLimits = defaultLimits,
) {
  let idleSince = Date.now()
  let lastChange = Date.now()
  const snapshot = async (pause?: number, requireIdle = false) => {
    const transaction = await backend.begin(namespace)
    const db = transaction.checkpoint.bytes.length ? Database.deserialize(transaction.checkpoint.bytes) : undefined
    try {
      if (!db?.query("SELECT name FROM sqlite_master WHERE name = 'cluster_worker_runtime'").get()) return
      const workers = db
        .query<
          WorkerMetrics,
          []
        >("SELECT roots, capacity, cpu, memory FROM cluster_worker_runtime WHERE expires > unixepoch('subsec') * 1000")
        .all()
      const queued =
        db
          .query<{ total: number }, []>(
            `
          WITH RECURSIVE roots(id, root) AS (
            SELECT id, id FROM session_v2 WHERE parent_id IS NULL
            UNION ALL SELECT s.id, r.root FROM session_v2 s JOIN roots r ON s.parent_id = r.id
          )
          SELECT count(DISTINCT r.root) AS total FROM cluster_wake w
          JOIN roots r ON r.id = w.session_id
          WHERE w.session_id IN (SELECT session_id FROM session_inbox)
          AND r.root NOT IN (SELECT session_id FROM cluster_assignments)
        `,
          )
          .get()?.total ?? 0
      const claims = db.query<{ total: number }, []>("SELECT count(*) AS total FROM cluster_assignments").get()!.total
      if (pause !== undefined) {
        if (requireIdle && (claims > 0 || queued > 0)) return
        db.run(
          "INSERT INTO cluster_scaling(id, pause_until) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET pause_until=excluded.pause_until",
          [pause],
        )
        await transaction.commit(db.serialize())
      }
      return { workers, queued, claims }
    } finally {
      db?.close()
      await transaction.rollback()
    }
  }
  return {
    async tick() {
      const current = await provider.current()
      if (current < limits.min || current > limits.max)
        throw new Error("Current worker count is outside the configured controller limits")
      const state = await snapshot()
      if (!state) return { reason: "waiting-for-workers", current }
      const response = await execution(new Request("http://executor/metrics"))
      if (!response.ok) throw new Error(`Executor metrics unavailable (${response.status}); keeping current capacity`)
      const metrics = (await response.json()) as { disk: { used: number; available: number } }
      if (
        !metrics.disk ||
        !Number.isFinite(metrics.disk.used) ||
        !Number.isFinite(metrics.disk.available) ||
        metrics.disk.used < 0 ||
        metrics.disk.used > 1 ||
        metrics.disk.available < 0
      )
        throw new Error("Executor disk metrics are invalid; keeping current capacity")
      if (state.claims || state.queued) idleSince = Date.now()
      const decision = scale(
        { current, workers: state.workers, queued: state.queued, disk: metrics.disk, idleFor: Date.now() - idleSince },
        limits,
      )
      if (decision.reason === "executor-disk-pressure") {
        await snapshot(Date.now() + 60_000)
        return { ...decision, current }
      }
      if (decision.desired === current || Date.now() - lastChange < 30_000) {
        await snapshot(0)
        return { ...decision, desired: current, current }
      }
      if (decision.desired < current) {
        // Recheck claims and the queue under the same state lock that publishes
        // the pause. Every worker checks it before acquiring a new root.
        const paused = await snapshot(Date.now() + 300_000, true)
        if (!paused) return { reason: "work-arrived", current }
      }
      // On failure retain the bounded pause until the next successful check.
      await provider.resize(decision.desired)
      lastChange = Date.now()
      await snapshot(0)
      return { ...decision, current }
    },
  }
}
