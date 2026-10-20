import { expect, test } from "bun:test"
import { Context } from "effect"
import { Database } from "@opencode/core/database/database"
import { OpenCode } from "@opencode/client"
import { createHost } from "../src/host"
import { SessionExecution } from "@opencode/core/session/execution"
import { admissionExecution } from "../src/control"

test("API replicas remove idle sessions and wait for durable execution settlement", async () => {
  const host = await createHost(
    { models: { fetch: false }, config: { project: false, claude: false }, fs: { filewatcher: false, fff: false } },
    [SessionExecution.node.replace(admissionExecution)],
  )
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: host.fetch })
  const client = OpenCode.make({ baseUrl: server.url.href })
  try {
    const session = await client.session.create({ location: { directory: "/tmp" }, title: "transport check" })
    await client.session.instructions.entry.put({
      sessionID: session.id,
      key: "diagnostic",
      value: "Only verify the transport",
    })
    expect(await client.session.instructions.entry.list({ sessionID: session.id })).toHaveLength(1)
    await client.session.remove({ sessionID: session.id })

    const running = await client.session.create({ location: { directory: "/tmp" }, title: "settlement check" })
    const db = Context.get(host.context, Database.Service).db
    const row = db.get(`SELECT id FROM session_v2 WHERE id = '${running.id}'`)
    await host.runtime.runPromise(db.run(`UPDATE session_v2 SET time_suspended = 1 WHERE id = '${running.id}'`))
    let settled = false
    const removal = client.session.remove({ sessionID: running.id }).then(() => {
      settled = true
    })
    try {
      // No worker heartbeat exists: a durable claim must still prevent deletion.
      await Bun.sleep(350)
      expect(settled).toBe(false)
      expect(await host.runtime.runPromise(row)).toBeDefined()
    } finally {
      await host.runtime.runPromise(db.run(`UPDATE session_v2 SET time_suspended = NULL WHERE id = '${running.id}'`))
      await removal
    }
    expect(await host.runtime.runPromise(row)).toBeUndefined()
  } finally {
    server.stop(true)
    await host.close()
  }
})
