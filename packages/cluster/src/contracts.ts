/**
 * The portable boundary contains no provider SDKs, process globals or Node imports.
 * SQLite is OpenCode's logical format, not the deployment's durability mechanism.
 */
export interface Checkpoint {
  readonly revision: number
  readonly bytes: Uint8Array
}

export interface Transaction {
  readonly checkpoint: Checkpoint
  /** Persist a changed image and release the transaction atomically. */
  commit(bytes?: Uint8Array): Promise<void>
  rollback(): Promise<void>
}

export interface StateBackend {
  /** Serializable transaction. Cancellation must roll back and release its lock. */
  begin(namespace: string, fence?: Fence): Promise<Transaction>
  acquire(namespace: string, owner: string, ttl: number): Promise<Fence | undefined>
  renew(fence: Fence, ttl: number): Promise<boolean>
  release(fence: Fence): Promise<void>
  close(): Promise<void>
}

export interface Fence {
  readonly namespace: string
  readonly owner: string
  readonly epoch: number
  /** Worker leases fence one process while sharing a namespace's state. */
  readonly scope?: "worker"
}

export interface WorkerStateBackend extends StateBackend {
  acquireWorker(namespace: string, owner: string, ttl: number): Promise<Fence | undefined>
  alive(fence: Fence): Promise<boolean>
}

export interface ObjectStore {
  get(key: string): Promise<Uint8Array | undefined>
  put(key: string, value: Uint8Array): Promise<void>
  remove(key: string): Promise<void>
}

export interface SecretProvider {
  resolve(reference: string): Promise<string>
}

export interface WakeScheduler {
  wake(namespace: string): Promise<void>
}

export interface ExecutionBackend {
  fetch(workspace: string, request: Request): Promise<Response>
  stop(workspace: string): Promise<void>
}

export class FencedError extends Error {
  constructor() {
    super("Execution ownership expired or was replaced")
    this.name = "FencedError"
  }
}

export interface Residency {
  readonly state: "us" | "unrestricted"
  readonly artifacts: "us" | "unrestricted"
  readonly execution: "us" | "unverified" | "unrestricted"
}

export function requireResidency(policy: "us" | "unrestricted", capabilities: Residency) {
  if (policy === "unrestricted") return
  if (Object.values(capabilities).some((value) => value !== "us"))
    throw new Error("This profile cannot guarantee U.S. placement for state, artifacts and execution")
}
