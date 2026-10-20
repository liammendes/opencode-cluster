export interface WorkerMetrics {
  roots: number
  capacity: number
  cpu: number
  memory: number
}

export interface ScalingInput {
  current: number
  workers: WorkerMetrics[]
  queued: number
  disk: { used: number; available: number }
  idleFor: number
}

export interface ScalingLimits {
  min: number
  max: number
  capacity: number
  cpu: number
  memory: number
  disk: number
  diskFree: number
  idleMillis: number
}

export const defaultLimits: ScalingLimits = {
  min: 1,
  max: 4,
  capacity: 4,
  cpu: 0.6,
  memory: 0.75,
  disk: 0.9,
  diskFree: 1024 ** 3,
  idleMillis: 300_000,
}

/** Provider-neutral decision. Applying a decrease also requires an atomic admission pause. */
export function scale(input: ScalingInput, limits: ScalingLimits = defaultLimits) {
  const blocked = input.disk.used >= limits.disk || input.disk.available < limits.diskFree
  const roots = input.workers.reduce((sum, worker) => sum + worker.roots, 0)
  if (blocked) return { desired: input.current, pause: true, reason: "executor-disk-pressure" }
  const busy = input.workers.filter((worker) => worker.roots > 0)
  const cpu = busy.reduce((sum, worker) => sum + worker.cpu, 0)
  const memory = busy.reduce((sum, worker) => sum + worker.memory, 0)
  const demand = Math.max(
    limits.min,
    Math.ceil((roots + input.queued) / limits.capacity),
    Math.ceil(cpu / limits.cpu),
    Math.ceil(memory / limits.memory),
  )
  if (demand > input.current)
    return { desired: Math.min(limits.max, demand), pause: false, reason: "queue-or-worker-utilization" }
  // Cloud Run chooses which instances stop. Decrease only when every expected
  // worker has reported idle, so an arbitrary victim cannot interrupt an agent.
  if (
    input.current > limits.min &&
    input.workers.length >= input.current &&
    roots === 0 &&
    input.queued === 0 &&
    input.idleFor >= limits.idleMillis
  )
    return { desired: limits.min, pause: true, reason: "idle" }
  return { desired: input.current, pause: false, reason: "hold" }
}

export interface CapacityProvider {
  current(): Promise<number>
  resize(count: number): Promise<void>
}
