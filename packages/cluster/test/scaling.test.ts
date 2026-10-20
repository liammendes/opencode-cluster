import { expect, test } from "bun:test"
import { defaultLimits, scale, type ScalingInput } from "../src/scaling"

const idle: ScalingInput = {
  current: 1,
  workers: [{ roots: 0, capacity: 4, cpu: 0.02, memory: 0.2 }],
  queued: 0,
  disk: { used: 0.3, available: 10 * 1024 ** 3 },
  idleFor: 0,
}

test("queue demand stays within the configured four-worker ceiling", () => {
  expect(scale({ ...idle, queued: 1000 }).desired).toBe(4)
  expect(scale({ ...idle, queued: 5 }).desired).toBe(2)
  expect(scale(idle).desired).toBe(1)
})

test("busy worker CPU and RAM can independently request more capacity", () => {
  expect(scale({ ...idle, workers: [{ roots: 1, capacity: 4, cpu: 0.95, memory: 0.3 }] }).desired).toBe(2)
  expect(scale({ ...idle, workers: [{ roots: 1, capacity: 4, cpu: 0.2, memory: 0.95 }] }).desired).toBe(2)
})

test("shared disk pressure pauses admission without creating more workers", () => {
  const decision = scale({ ...idle, queued: 100, disk: { used: 0.95, available: 10 * 1024 ** 3 } })
  expect(decision).toEqual({ desired: 1, pause: true, reason: "executor-disk-pressure" })
  expect(scale({ ...idle, disk: { used: 0.1, available: 1 } }).pause).toBe(true)
})

test("scale-in requires all expected workers to be idle throughout the cooldown", () => {
  const workers = Array.from({ length: 4 }, () => idle.workers[0]!)
  const state = { ...idle, current: 4, workers, idleFor: defaultLimits.idleMillis }
  expect(scale(state).desired).toBe(1)
  expect(scale({ ...state, idleFor: 1000 }).desired).toBe(4)
  expect(scale({ ...state, workers: workers.slice(1) }).desired).toBe(4)
  expect(scale({ ...state, workers: [{ ...workers[0]!, roots: 1 }, ...workers.slice(1)] }).desired).toBe(4)
  expect(scale({ ...state, queued: 1 }).desired).toBe(4)
})
