import { PostgresState } from "./postgres"
import { authenticatedTransport } from "../execution/protocol"

const positive = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1) throw new Error(name + " must be a positive integer")
  return value
}
const required = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(name + " is required")
  return value
}
const namespace = process.env.CLUSTER_NAMESPACE ?? "default"
const role = process.env.CLUSTER_ROLE ?? "api"
if (!["api", "worker", "autoscaler"].includes(role)) throw new Error("CLUSTER_ROLE must be api, worker or autoscaler")
const backend = new PostgresState(required("CLUSTER_DATABASE_URL"), {
  max: positive("CLUSTER_DATABASE_CONNECTIONS", 4),
  ...(process.env.CLUSTER_DATABASE_SOCKET ? { path: process.env.CLUSTER_DATABASE_SOCKET } : {}),
})
const execution = authenticatedTransport(required("EXECUTION_URL"), required("EXECUTION_TOKEN"))
await backend.initialize()
let closing = false
let dispose = async () => {}
const close = async () => {
  if (closing) return
  closing = true
  await dispose()
  await backend.close()
}
process.once("SIGTERM", () => void close())
process.once("SIGINT", () => void close())

if (role === "autoscaler") {
  const { cloudRunCapacity } = await import("./cloud-run")
  const { createScaler } = await import("./scaler")
  const { defaultLimits } = await import("../scaling")
  const min = positive("CLUSTER_MIN_WORKERS", 1)
  const max = positive("CLUSTER_MAX_WORKERS", 4)
  if (min > max) throw new Error("CLUSTER_MIN_WORKERS cannot exceed CLUSTER_MAX_WORKERS")
  const controller = createScaler(
    backend,
    namespace,
    cloudRunCapacity(
      required("GOOGLE_CLOUD_PROJECT"),
      required("CLUSTER_REGION"),
      required("CLUSTER_WORKER_SERVICE"),
      max,
    ),
    execution,
    { ...defaultLimits, min, max, capacity: positive("CLUSTER_CONCURRENCY", 4) },
  )
  // A replacement must pass its startup probe before Cloud Run retires the old
  // revision. Stay ready while waiting for that controller's lease to end.
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: Number(process.env.PORT ?? "8080"),
    fetch: () => new Response("ok"),
  })
  dispose = async () => {
    server.stop(true)
  }
  console.log(JSON.stringify({ role, namespace, port: server.port, state: "standby" }))
  const fence = await (async () => {
    while (!closing) {
      const owned = await backend.acquire(namespace + ":autoscaler", crypto.randomUUID(), 60_000)
      if (owned) return owned
      await Bun.sleep(1000)
    }
  })()
  if (fence && !closing) {
    console.log(JSON.stringify({ role, namespace, state: "leader" }))
    let healthy = true
    let renewing = false
    const timer = setInterval(async () => {
      if (renewing || closing) return
      renewing = true
      healthy = await backend.renew(fence, 60_000).catch(() => false)
      renewing = false
      if (!healthy) void close()
    }, 10_000)
    dispose = async () => {
      clearInterval(timer)
      server.stop(true)
      await backend.release(fence)
    }
    while (!closing && healthy) {
      try {
        console.log(JSON.stringify({ role, ...(await controller.tick()) }))
      } catch (error) {
        console.error(JSON.stringify({ role, error: error instanceof Error ? error.message : "Scaling check failed" }))
      }
      if (!closing) await Bun.sleep(15_000)
    }
  }
} else {
  const { createReplica } = await import("./server")
  const { createPoolWorker } = await import("./pool")
  const { utilization } = await import("./utilization")
  const options = {
    backend,
    namespace,
    execution,
    server: {
      app: { name: "opencode-cluster", version: "2.0.32-cluster.2" },
      password: required("CLUSTER_PASSWORD"),
      config: { project: false, claude: false, content: process.env.OPENCODE_CONFIG_CONTENT ?? "{}" },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
    },
  }
  const fence = role === "worker" ? await backend.acquireWorker(namespace, crypto.randomUUID(), 60_000) : undefined
  if (role === "worker" && !fence)
    throw new Error("A legacy worker still owns this namespace; stop it before enabling the pool")
  let healthy = true
  let ready = false
  let renewing = false
  const timer = fence
    ? setInterval(async () => {
        if (renewing || closing) return
        renewing = true
        healthy = await backend.renew(fence, 60_000).catch(() => false)
        renewing = false
        if (!healthy && ready) void close()
      }, 10_000)
    : undefined
  const worker = fence ? await createPoolWorker(options, fence, positive("CLUSTER_CONCURRENCY", 4)) : undefined
  const host = worker ?? (await createReplica(options))
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: Number(process.env.PORT ?? "8080"),
    idleTimeout: 0,
    fetch: (request) => host.fetch(request),
  })
  dispose = async () => {
    clearInterval(timer)
    server.stop(true)
    await host.close()
    if (fence) await backend.release(fence)
  }
  ready = true
  if (!healthy) await close()
  console.log(JSON.stringify({ role, namespace, port: server.port }))
  const sample = utilization(positive("CLUSTER_CPU_LIMIT", 1), positive("CLUSTER_MEMORY_BYTES", 2 * 1024 ** 3))
  while (worker && !closing) {
    try {
      await worker.tick(await sample())
    } catch (error) {
      if (closing) break
      console.error("Worker stopped after a state or ownership error")
      await close()
      throw error
    }
    if (!closing) await Bun.sleep(1000)
  }
}
