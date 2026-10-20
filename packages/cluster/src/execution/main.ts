import { mkdir } from "node:fs/promises"
import { createBroker } from "./broker"

const root = process.env.WORKSPACE_ROOT ?? "/workspace"
await mkdir(root, { recursive: true })
const broker = createBroker(process.env.EXECUTION_TOKEN ?? "", root)
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? "8081"),
  idleTimeout: 0,
  fetch: (request) => broker.fetch(request),
})
process.once("SIGTERM", () => {
  broker.close()
  server.stop(true)
})
