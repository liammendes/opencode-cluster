import type { CapacityProvider } from "../scaling"

/** Only this adapter depends on Google Cloud. The policy and worker pool do not. */
export function cloudRunCapacity(project: string, region: string, service: string, max: number): CapacityProvider {
  const url = `https://run.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/services/${encodeURIComponent(service)}`
  const request = async (url: string, init?: RequestInit) => {
    const tokenResponse = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(10_000) },
    )
    if (!tokenResponse.ok) throw new Error(`Cloud identity unavailable (${tokenResponse.status})`)
    const token = (await tokenResponse.json()) as { access_token: string }
    const response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Cloud Run capacity request failed (${response.status})`)
    return response.json()
  }
  return {
    async current() {
      const state = (await request(url)) as {
        reconciling?: boolean
        scaling?: { scalingMode?: string; manualInstanceCount?: number }
      }
      if (state.reconciling) throw new Error("Cloud Run is still applying the previous capacity update")
      if (state.scaling?.scalingMode !== "MANUAL")
        throw new Error("Set the worker service to manual scaling before starting the controller")
      return state.scaling.manualInstanceCount ?? 0
    },
    async resize(count) {
      if (!Number.isInteger(count) || count < 1 || count > max)
        throw new Error("Worker count is outside the configured limit")
      const operation = (await request(url + "?updateMask=scaling.manualInstanceCount", {
        method: "PATCH",
        body: JSON.stringify({ scaling: { manualInstanceCount: count } }),
      })) as { name: string; done?: boolean; error?: unknown }
      const deadline = Date.now() + 240_000
      let state = operation
      while (!state.done) {
        if (Date.now() > deadline) throw new Error("Cloud Run capacity update is still pending")
        await Bun.sleep(2000)
        state = (await request(`https://run.googleapis.com/v2/${operation.name}`)) as typeof operation
      }
      if (state.error) throw new Error("Cloud Run rejected the capacity update")
    },
  }
}
