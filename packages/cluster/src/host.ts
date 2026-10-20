import { Context, Effect, Layer, ManagedRuntime, type Scope } from "effect"
import { HttpEffect, HttpRouter, HttpServer, type HttpServerRequest } from "effect/http"
import { createRoutes } from "@opencode/server/routes"
import type { ServerOptions } from "@opencode/server/options"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Config } from "@opencode/core/config"

/** Own the Effect runtime explicitly so replicas can drain and release resources. */
export async function createHost(options: ServerOptions, overrides: LayerNode.Replacements = []) {
  const runtime = ManagedRuntime.make(
    createRoutes(options, () => [], [
      Config.node.replace(
        Config.configured({
          global: false,
          project: false,
          claude: false,
          content: options.config?.content ?? "{}",
        }),
      ),
      ...overrides,
    ]).pipe(Layer.provide(HttpServer.layerServices)),
  )
  const context = await runtime.context()
  const router = Context.get(context, HttpRouter.HttpRouter)
  const handler = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest | Scope.Scope>(context)(
    router.asHttpEffect(),
  )
  return {
    context,
    runtime,
    fetch: (request: Request) => {
      const path = new URL(request.url).pathname
      // These upstream features own local processes/files or ephemeral pairing
      // tokens. Reject them explicitly instead of returning replica-local state.
      if (
        /^\/api\/(?:persistent-pty|pty|worktree|vcs)(?:\/|$)/.test(path) ||
        path === "/api/experimental/config" ||
        path === "/api/pair" ||
        path.startsWith("/auth/connect/")
      )
        return Promise.resolve(
          Response.json(
            {
              error:
                "This endpoint is not supported by the cluster alpha. Use inline deployment configuration, password authentication and remote shell/Git tools.",
            },
            { status: 501 },
          ),
        )
      return handler(request)
    },
    close: () => runtime.dispose(),
  }
}

export type Host = Awaited<ReturnType<typeof createHost>>

export function run<A, E>(host: Host, effect: Effect.Effect<A, E>) {
  return host.runtime.runPromise(effect)
}
