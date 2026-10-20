import { readFile } from "node:fs/promises"
import { OpenCode } from "@opencode/client"

/**
 * A Paseo generation owns its HTTP connections, never the remote OpenCode server.
 * Installed next to Paseo's v2/runtime.js by install.mjs.
 */
export async function createRemoteGeneration(settings) {
  const url = new URL(settings.OPENCODE_REMOTE_URL)
  if (url.username || url.password || url.search || url.hash)
    throw new Error("OPENCODE_REMOTE_URL must not contain credentials, a query or a fragment")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))
    throw new Error("Remote OpenCode requires HTTPS")
  if (!settings.OPENCODE_REMOTE_PASSWORD_FILE)
    throw new Error("OPENCODE_REMOTE_PASSWORD_FILE is required")
  const password = (await readFile(settings.OPENCODE_REMOTE_PASSWORD_FILE, "utf8")).trim()
  if (!password) throw new Error("Remote OpenCode password file is empty")
  const abort = new AbortController()
  const exited = new Promise((resolve) => {
    abort.signal.addEventListener("abort", () => resolve(new Error("Remote OpenCode connection released")), { once: true })
  })
  const client = OpenCode.make({
    baseUrl: url.href.replace(/\/$/, ""),
    headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "User-Agent": "opencode-cluster-paseo/0.1",
    },
    fetch: async (request, init) => {
      const signal = init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal
      const response = await fetch(request, { ...init, signal, redirect: "error" })
      if (response.headers.get("content-type")?.includes("text/html")) {
        const path = new URL(request instanceof Request ? request.url : String(request)).pathname
        throw new Error(`Remote OpenCode ${path} returned HTTP ${response.status}`)
      }
      return response
    },
  })
  await client.server.info({ signal: AbortSignal.timeout(30_000) })
  return { client, users: 0, exited, stop: async () => abort.abort() }
}
