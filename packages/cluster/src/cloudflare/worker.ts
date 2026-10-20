import { Context, Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionSchema } from "@opencode/core/session/schema"
import { ServerWorkerd } from "@opencode/server/workerd"
import { createHost, type Host } from "../host"
import { requireResidency } from "../contracts"
import { executionLayers } from "../execution/layers"
import { authenticatedTransport } from "../execution/protocol"
import type { Env, State } from "./types"
import { exportArchive, importTables, verifyArchive, type Archive, type PortableSql } from "../archive"
import { initializeControl } from "../control"

export default {
  async fetch(request: Request, env: Env) {
    if (!env.CLUSTER_PASSWORD || !env.EXECUTION_TOKEN)
      return new Response("Cluster secrets are not configured", { status: 503 })
    const expected = `Basic ${btoa(`opencode:${env.CLUSTER_PASSWORD}`)}`
    if (request.headers.get("authorization") !== expected)
      return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="OpenCode"' } })
    requireResidency(env.RESIDENCY ?? "us", {
      state: "us",
      artifacts: "us",
      execution: env.EXECUTION_RESIDENCY ?? "unverified",
    })
    const namespaces = env.RESIDENCY === "unrestricted" ? env.NAMESPACES : env.NAMESPACES.jurisdiction("us")
    return namespaces.getByName(env.CLUSTER_NAMESPACE ?? "default").fetch(request)
  },
}

/** One authority per installation namespace; many sessions share its runtime. */
export class OpenCodeNamespace {
  private ready?: Promise<Host>

  constructor(
    private readonly ctx: State,
    private readonly env: Env,
  ) {}

  private host() {
    return (this.ready ??= this.ctx.blockConcurrencyWhile(async () => {
      const { ctx, env } = this
      const options = {
        storage: ctx.storage,
        password: env.CLUSTER_PASSWORD,
        config: { content: env.OPENCODE_CONFIG_CONTENT ?? "{}" },
        models: { fetch: false },
      }
      const sandbox = env.SANDBOXES.getByName(env.CLUSTER_NAMESPACE ?? "default")
      const host = await createHost(ServerWorkerd.serverOptions(options), [
        ...ServerWorkerd.replacements(options),
        ...executionLayers(
          env.EXECUTION_URL
            ? authenticatedTransport(env.EXECUTION_URL, env.EXECUTION_TOKEN)
            : (request) => {
                const headers = new Headers(request.headers)
                headers.set("authorization", `Bearer ${env.EXECUTION_TOKEN}`)
                return sandbox.fetch(new Request(request, { headers }))
              },
        ),
        SessionRestart.node.replace(SessionRestart.configured({ maxAttempts: 0 })),
      ])
      const db = Context.get(host.context, Database.Service).db
      await host.runtime.runPromise(initializeControl(db))
      await host.runtime.runPromise(
        db
          .run(
            "DELETE FROM cluster_wake WHERE session_id IN (SELECT id FROM session_v2 WHERE time_suspended IS NOT NULL)",
          )
          .pipe(Effect.orDie),
      )
      // Recovery reports orphaned tool outcomes as interrupted; it does not
      // promise exactly-once execution across a sandbox or isolate crash.
      await host.runtime.runPromise(Context.get(host.context, SessionRestart.Service).resumeSuspendedSessions)
      return host
    }))
  }

  async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === "/cluster/checkpoint" && request.method === "POST") {
      if (this.env.EXECUTION_URL)
        return new Response("Checkpoint the external executor's volume through its storage provider", { status: 501 })
      const host = await this.host()
      const active = await host.runtime.runPromise(Context.get(host.context, SessionExecution.Service).active)
      if (active.size) return new Response("Drain active sessions before checkpointing", { status: 409 })
      return this.env.SANDBOXES.getByName(this.env.CLUSTER_NAMESPACE ?? "default").fetch(
        new Request("http://sandbox/checkpoint", {
          method: "POST",
          headers: { authorization: `Bearer ${this.env.EXECUTION_TOKEN}` },
        }),
      )
    }
    if (url.pathname === "/cluster/archive") {
      const sql: PortableSql = {
        all: (query, params = []) => this.ctx.storage.sql.exec(query, ...params).toArray(),
        values: (query) => Array.from(this.ctx.storage.sql.exec(query).raw()),
        exec: (query, params = []) => {
          this.ctx.storage.sql.exec(query, ...params)
        },
      }
      if (request.method === "POST") {
        const archive = (await request.json()) as Archive
        await verifyArchive(archive)
        return this.ctx.blockConcurrencyWhile(async () => {
          if (this.ready) return new Response("Import requires a fresh, unused namespace", { status: 409 })
          this.ctx.storage.transactionSync(() => importTables(sql, archive))
          return Response.json({ imported: true, checksum: archive.checksum })
        })
      }
      if (request.method === "GET") {
        const host = await this.host()
        const active = await host.runtime.runPromise(Context.get(host.context, SessionExecution.Service).active)
        if (active.size || sql.all("SELECT id FROM session_inbox LIMIT 1").length)
          return new Response("Drain or cancel pending work before export", { status: 409 })
        return this.ctx.blockConcurrencyWhile(async () => Response.json(await exportArchive(sql)))
      }
      return new Response("Method not allowed", { status: 405 })
    }
    // Arm before admission, so an acknowledgement can never leave work without
    // a durable wake if the requesting connection disappears.
    const input =
      request.method === "POST" && /\/(prompt|compact|move)$/.test(url.pathname)
        ? ((await request.clone().json()) as { resume?: boolean })
        : undefined
    if (input?.resume !== false && request.method !== "GET") await this.ctx.storage.setAlarm(Date.now() + 1000)
    const host = await this.host()
    const response = await host.fetch(request)
    const session = /\/session\/([^/]+)\/(prompt|compact|move|interrupt)$/.exec(url.pathname)
    if (session && response.ok) {
      const db = Context.get(host.context, Database.Service).db
      const id = decodeURIComponent(session[1]).replaceAll("'", "''")
      if (session[2] === "interrupt")
        await host.runtime.runPromise(db.run(`DELETE FROM cluster_wake WHERE session_id = '${id}'`).pipe(Effect.orDie))
      if (session[2] !== "interrupt" && input?.resume !== false)
        await host.runtime.runPromise(
          db
            .run(
              `INSERT INTO cluster_wake (session_id) VALUES ('${id}')
          ON CONFLICT (session_id) DO UPDATE SET phase = 'pending'`,
            )
            .pipe(Effect.orDie),
        )
    }
    return response
  }

  async alarm() {
    const host = await this.host()
    const execution = Context.get(host.context, SessionExecution.Service)
    const db = Context.get(host.context, Database.Service).db
    await this.ctx.storage.setAlarm(Date.now() + 60_000)
    await host.runtime.runPromise(
      Effect.gen(function* () {
        const rows = yield* db
          .all<{
            session_id: string
          }>("SELECT session_id FROM cluster_wake WHERE session_id IN (SELECT session_id FROM session_inbox)")
          .pipe(Effect.orDie)
        for (const row of rows) yield* execution.wake(SessionSchema.ID.make(row.session_id))
        const active = yield* execution.active
        yield* Effect.forEach(active, (id) => execution.awaitIdle(id), { concurrency: "unbounded" }).pipe(
          Effect.timeoutOption("12 minutes"),
        )
      }),
    )
    const active = await host.runtime.runPromise(execution.active)
    const pending = await host.runtime.runPromise(
      db
        .get<{
          total: number
        }>("SELECT count(*) AS total FROM cluster_wake WHERE session_id IN (SELECT session_id FROM session_inbox)")
        .pipe(Effect.orDie),
    )
    if (active.size || pending!.total) return this.ctx.storage.setAlarm(Date.now() + 1000)
    await this.ctx.storage.deleteAlarm()
  }
}

/** Cloudflare-only execution; no GCP service is required. */
export class ExecutionSandbox {
  private ready?: Promise<void>

  constructor(
    private readonly ctx: State,
    private readonly env: Env,
  ) {}

  async fetch(request: Request) {
    if (request.headers.get("authorization") !== `Bearer ${this.env.EXECUTION_TOKEN}`)
      return new Response("Unauthorized", { status: 401 })
    const container = this.ctx.container
    if (!container) return new Response("Sandbox container binding is missing", { status: 503 })
    if (new URL(request.url).pathname === "/checkpoint" && request.method === "POST") {
      const id = await this.checkpoint()
      return id ? Response.json({ id }) : new Response("No running sandbox", { status: 409 })
    }
    if (!this.ready || !container.running) {
      this.ready = this.ctx.blockConcurrencyWhile(async () => {
        if (container.running) return
        const snapshot = await this.ctx.storage.get<{ id: string }>("checkpoint")
        container.start({
          ...(snapshot ? { containerSnapshot: snapshot } : { image: container.images.base }),
          enableInternet: true,
          env: { EXECUTION_TOKEN: this.env.EXECUTION_TOKEN, WORKSPACE_ROOT: "/workspace", PORT: "8081" },
        })
        // Starting a VM is not proof that its HTTP process is ready.
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          const response = await container
            .getTcpPort(8081)
            .fetch(
              new Request("http://sandbox/health", {
                headers: { authorization: `Bearer ${this.env.EXECUTION_TOKEN}` },
              }),
            )
            .catch(() => undefined)
          if (response?.ok) return
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        throw new Error("Sandbox did not become ready")
      })
    }
    await this.ready
    return container.getTcpPort(8081).fetch(request)
  }

  /** Explicit checkpoint after draining; never assume a VM snapshot preserves processes. */
  async checkpoint() {
    const container = this.ctx.container
    if (!container?.running) return
    const snapshot = await container.snapshotContainer()
    await this.ctx.storage.put("checkpoint", snapshot)
    return snapshot.id
  }
}
