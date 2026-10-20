export interface Spawn {
  readonly id: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly extendEnv?: boolean
  readonly shell?: boolean | string
}

export type Transport = (request: Request) => Promise<Response>

export function authenticatedTransport(url: string, token: string): Transport {
  const base = new URL(url)
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("Execution URL must use HTTP or HTTPS")
  return (request) => {
    const target = new URL(new URL(request.url).pathname, base)
    const headers = new Headers(request.headers)
    headers.set("authorization", `Bearer ${token}`)
    return fetch(new Request(target, { method: request.method, body: request.body, headers, signal: request.signal }))
  }
}
