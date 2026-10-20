import type { ObjectStore } from "./contracts"
import type { Bucket } from "./cloudflare/types"

export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: Bucket) {}
  async get(key: string) {
    const value = await this.bucket.get(key)
    return value ? new Uint8Array(await value.arrayBuffer()) : undefined
  }
  async put(key: string, value: Uint8Array) {
    await this.bucket.put(key, value)
  }
  async remove(key: string) {
    await this.bucket.delete(key)
  }
}

/** S3/GCS signed object URLs can use the same portable transport. */
export class HttpObjectStore implements ObjectStore {
  constructor(private readonly authorize: (key: string, method: string) => Promise<Request>) {}
  async get(key: string) {
    const response = await fetch(await this.authorize(key, "GET"))
    if (response.status === 404) return
    if (!response.ok) throw new Error(`Object read failed: ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }
  async put(key: string, value: Uint8Array) {
    const request = await this.authorize(key, "PUT")
    const response = await fetch(new Request(request, { body: new Uint8Array(value).buffer }))
    if (!response.ok) throw new Error(`Object write failed: ${response.status}`)
  }
  async remove(key: string) {
    const response = await fetch(await this.authorize(key, "DELETE"))
    if (!response.ok && response.status !== 404) throw new Error(`Object delete failed: ${response.status}`)
  }
}
