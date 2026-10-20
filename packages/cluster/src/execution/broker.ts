import type { Subprocess } from "bun"
import { statfs } from "node:fs/promises"
import type { Spawn } from "./protocol"

/**
 * Run only in an isolated Linux execution container. This service intentionally
 * executes arbitrary agent code. Never expose it unauthenticated or mount a host
 * home directory, Docker socket, cloud credentials or the control-plane database.
 */
export function createBroker(token: string, root = "/workspace") {
  if (!token) throw new Error("Execution token is required")
  const processes = new Map<
    string,
    {
      input: Spawn
      process: Subprocess<"pipe", "pipe", "pipe">
      completed?: number
    }
  >()
  return {
    async fetch(request: Request): Promise<Response> {
      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return new Response("Unauthorized", { status: 401 })
      const url = new URL(request.url)
      if (url.pathname === "/health") return new Response("ok")
      if (url.pathname === "/metrics" && request.method === "GET") {
        const disk = await statfs(root)
        return Response.json({
          disk: {
            used: disk.blocks ? 1 - disk.bavail / disk.blocks : 1,
            available: disk.bavail * disk.bsize,
          },
          processes: [...processes.values()].filter((item) => item.process.exitCode === null).length,
        })
      }
      if (url.pathname === "/process" && request.method === "POST") {
        const input = (await request.json()) as Spawn
        if (
          !/^[0-9a-f-]{36}$/.test(input.id) ||
          typeof input.command !== "string" ||
          !Array.isArray(input.args) ||
          input.args.some((arg) => typeof arg !== "string")
        )
          return new Response("Invalid spawn", { status: 400 })
        const previous = processes.get(input.id)
        if (previous)
          return JSON.stringify(previous.input) === JSON.stringify(input)
            ? Response.json({ id: input.id })
            : new Response("Command ID conflict", { status: 409 })
        for (const [id, item] of processes)
          if (item.completed && item.completed < Date.now() - 300_000) processes.delete(id)
        if (processes.size >= 512) return new Response("Execution capacity reached", { status: 503 })
        const inherited = { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8" }
        const env = input.env && input.extendEnv === false ? input.env : { ...inherited, ...input.env }
        const args = [input.command, ...input.args]
        const child = Bun.spawn(
          input.shell ? [typeof input.shell === "string" ? input.shell : "/bin/sh", "-c", args.join(" ")] : args,
          {
            cwd: input.cwd ?? root,
            env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            detached: true,
          },
        )
        const item = { input, process: child, completed: undefined as number | undefined }
        processes.set(input.id, item)
        void child.exited.then(() => {
          item.completed = Date.now()
        })
        return Response.json({ id: input.id })
      }
      const match = /^\/process\/([0-9a-f-]{36})(?:\/(stdout|stderr|stdin|result|running))?$/.exec(url.pathname)
      const item = match && processes.get(match[1])
      if (!match || !item)
        return new Response("Unknown process; outcome may be uncertain after executor restart", { status: 404 })
      const child = item.process
      const action = match[2]
      if (!action && request.method === "DELETE") {
        killTree(child)
        return new Response(null, { status: 204 })
      }
      if (action === "stdout" || action === "stderr") return new Response(child[action])
      if (action === "result") return Response.json({ code: await child.exited })
      if (action === "running") return Response.json(child.exitCode === null)
      if (action === "stdin" && request.method === "POST") {
        child.stdin.write(new Uint8Array(await request.arrayBuffer()))
        await child.stdin.flush()
        return new Response(null, { status: 204 })
      }
      if (action === "stdin" && request.method === "DELETE") {
        child.stdin.end()
        return new Response(null, { status: 204 })
      }
      return new Response("Not found", { status: 404 })
    },
    close() {
      for (const item of processes.values()) killTree(item.process)
    },
  }
}

function killTree(child: Subprocess<"pipe", "pipe", "pipe">) {
  // Each Linux/POSIX command owns a process group, including shell descendants.
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}
