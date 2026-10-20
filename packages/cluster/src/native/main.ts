import { PostgresState } from "./postgres"
import { createReplica, createWorker } from "./server"
import { authenticatedTransport } from "../execution/protocol"

const url = process.env.CLUSTER_DATABASE_URL
const password = process.env.CLUSTER_PASSWORD
if (!url || !password) throw new Error("CLUSTER_DATABASE_URL and CLUSTER_PASSWORD are required")
if (!process.env.EXECUTION_URL || !process.env.EXECUTION_TOKEN)
  throw new Error("EXECUTION_URL and EXECUTION_TOKEN must point to an isolated executor")
const namespace = process.env.CLUSTER_NAMESPACE ?? "default"
const role = process.env.CLUSTER_ROLE ?? "api"
if (!["api", "worker"].includes(role)) throw new Error("CLUSTER_ROLE must be api or worker")
const backend = new PostgresState(url)
await backend.initialize()
const options = {
  backend,
  namespace,
  execution:
    process.env.EXECUTION_URL && process.env.EXECUTION_TOKEN
      ? authenticatedTransport(process.env.EXECUTION_URL, process.env.EXECUTION_TOKEN)
      : undefined,
  server: {
    app: { name: "opencode-cluster", version: "2.0.32-cluster.1" },
    password,
    config: {
      project: false,
      claude: false,
      content: process.env.OPENCODE_CONFIG_CONTENT ?? "{}",
    },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
  },
}
const owner = crypto.randomUUID()
const ttl = 30_000
const fence = role === "worker" ? await backend.acquire(namespace, owner, ttl) : undefined
if (role === "worker" && !fence) throw new Error("Another worker currently owns this namespace")
const worker = fence ? await createWorker(options, fence) : undefined
const host = worker ?? (await createReplica(options))
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? "8080"),
  idleTimeout: 0,
  fetch: (request) => host.fetch(request),
})
let closing = false
const close = async () => {
  if (closing) return
  closing = true
  server.stop(true)
  await host.close()
  if (fence) await backend.release(fence)
  await backend.close()
}
process.once("SIGTERM", () => void close())
process.once("SIGINT", () => void close())

console.log(JSON.stringify({ role, namespace, port: server.port }))
if (fence && worker) {
  const concurrency = Number(process.env.CLUSTER_CONCURRENCY ?? "8")
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("CLUSTER_CONCURRENCY must be a positive integer")
  // Run under instance-based CPU allocation on Cloud Run. Admission is durable;
  // a disconnected HTTP client is never responsible for keeping this loop alive.
  while (!closing) {
    if (!(await backend.renew(fence, ttl))) {
      await close()
      throw new Error("Lost execution lease; worker stopped")
    }
    await worker.tick(concurrency)
    await Bun.sleep(1000)
  }
}
