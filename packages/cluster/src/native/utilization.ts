import { readFile } from "node:fs/promises"

const number = async (paths: string[]) => {
  for (const path of paths) {
    const value = await readFile(path, "utf8").catch(() => "")
    if (value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
}

/** Sample the container where available; process counters support other native hosts. */
export function utilization(cpuLimit: number, memoryLimit: number) {
  let previous = { time: performance.now(), cpu: process.cpuUsage() }
  return async () => {
    const time = performance.now()
    const cpu = process.cpuUsage()
    const elapsed = Math.max(1, (time - previous.time) * 1000)
    const used = cpu.user + cpu.system - previous.cpu.user - previous.cpu.system
    previous = { time, cpu }
    const bytes =
      (await number(["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"])) ??
      process.memoryUsage().rss
    return { cpu: Math.max(0, used / elapsed / cpuLimit), memory: bytes / memoryLimit }
  }
}
