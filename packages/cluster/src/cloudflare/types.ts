import type { DurableObjectStorage } from "@opencode/core/database/sqlite.workerd"

// Structural types avoid conflicting Bun/Workers ambient globals in the monorepo.
export interface Storage extends DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  setAlarm(time: number): Promise<void>
  deleteAlarm(): Promise<void>
}

export interface Stub {
  fetch(request: Request): Promise<Response>
}

export interface Namespace {
  getByName(name: string): Stub
  jurisdiction(value: "us"): Namespace
}

export interface Container {
  readonly running: boolean
  readonly images: Record<string, string>
  start(options: {
    image?: string
    containerSnapshot?: { id: string }
    enableInternet: boolean
    env: Record<string, string>
  }): void
  getTcpPort(port: number): Stub
  destroy(): Promise<void>
  snapshotContainer(): Promise<{ id: string }>
  setInactivityTimeout(milliseconds: number): void
}

export interface State {
  readonly storage: Storage
  readonly container?: Container
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
  waitUntil(promise: Promise<unknown>): void
}

export interface Bucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  put(key: string, value: Uint8Array): Promise<unknown>
  delete(key: string): Promise<void>
}

export interface Env {
  readonly NAMESPACES: Namespace
  readonly SANDBOXES: Namespace
  readonly ARTIFACTS: Bucket
  readonly CLUSTER_PASSWORD: string
  readonly EXECUTION_TOKEN: string
  readonly EXECUTION_URL?: string
  readonly CLUSTER_NAMESPACE?: string
  readonly OPENCODE_CONFIG_CONTENT?: string
  readonly RESIDENCY?: "us" | "unrestricted"
  readonly EXECUTION_RESIDENCY?: "us" | "unverified"
}
