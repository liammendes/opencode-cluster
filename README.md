<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/cluster/assets/wordmark-dark.svg">
    <img src="packages/cluster/assets/wordmark-light.svg" width="760" alt="opencode-cluster">
  </picture>
</p>

<p align="center">
  Shared state. Pooled agents. Your infrastructure.
</p>

<p align="center">
  <a href="CLUSTER.md">Get started</a> ·
  <a href="CLUSTER.md#deployment-profiles">Deployment profiles</a> ·
  <a href="CLUSTER.md#tests-and-measurements">Tests and measurements</a> ·
  <a href="packages/cluster/UPSTREAM.md">Upstream updates</a>
</p>

**opencode-cluster** is an experimental, vendor-neutral fork of
[OpenCode](https://github.com/anomalyco/opencode). Multiple API replicas share
authoritative session state, while a pooled execution worker runs several agents
in one process. Deploy on your own infrastructure or use the Cloudflare Workers
adapter.

**Status: alpha.** Shared state, recovery and local execution are tested. A fleet
of thousands of simultaneously active agents has not been demonstrated. Start
with the [current limits](CLUSTER.md#current-limits).

## Why this exists

One OpenCode process per agent becomes expensive as a workload grows. This fork
separates the HTTP API, durable state and tool execution so sessions can share an
OpenCode runtime. Any native API replica can read the same committed session
state; clients do not need to remember which replica created it.

## What is included

- **Shared session state:** PostgreSQL for native deployments, or Durable Object
  SQLite on Cloudflare.
- **Pooled execution:** durable prompt admission, renewable worker leases and
  protection against state writes from an expired worker.
- **Portable tools:** a separate Linux executor with streaming process input and
  output, remote files and shell/Git support.
- **State portability:** checksummed database archives between native SQLite and
  Durable Objects, with stored credential values excluded.
- **Upstream maintenance:** a normal Git fork with small core hooks and the
  cluster implementation isolated in `packages/cluster`.

## Choose a deployment

| Environment                | Start here                                                       | Verification                                                                                                    |
| -------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Local Docker / self-hosted | [Native setup](CLUSTER.md#try-the-native-deployment)             | Separate API containers, PostgreSQL and a Linux executor tested locally                                         |
| Google Cloud Run           | [GCP guide](packages/cluster/deploy/gcp/README.md)               | API manifest supplied; no live GCP deployment                                                                   |
| Cloudflare Workers         | [Cloudflare guide](packages/cluster/deploy/cloudflare/README.md) | Local workerd API, restart, archive round trip and synthetic agent turn tested; managed containers not deployed |

Cloudflare is optional. The native deployment does not depend on a Cloudflare
service, and the Cloudflare deployment does not require a Google service.

## Get started

Clone this fork, then follow the [native setup](CLUSTER.md#try-the-native-deployment)
to start PostgreSQL, two API replicas and a pooled execution worker:

```sh
git clone --branch cluster-v2.0.32 https://github.com/liammendes/opencode-cluster.git
cd opencode-cluster
```

The setup guide covers credentials, model configuration and persistent workspace
volumes. Cloud Run and Cloudflare have their own deployment guides above.
Paseo and real Mercury workloads still need integration testing; Paseo must use
the shared server to avoid spawning a local OpenCode process for every agent.

## What the 1,000-session result means

A local baseline created **1,000 tiny stored sessions**, replaced an API runtime,
then read every session back. It used two API runtimes inside one Bun process and
PostgreSQL 17 in OrbStack on a Mac. It made **zero model calls and ran zero tools**.

The run took about 105 seconds to create the sessions and 133 seconds overall.
Bun process RSS rose from 267 to 328 MiB; those figures exclude PostgreSQL and
executor memory. This measures stored-session behavior, not 1,000 busy agents.
See the [measurement details and test commands](CLUSTER.md#tests-and-measurements).

## Development and upstream updates

This branch starts from **OpenCode v2.0.32**. Use the
[upstream update guide](packages/cluster/UPSTREAM.md) to replay the cluster commits
on a newer upstream revision.

With Bun 1.4.2 installed:

```sh
bun install --frozen-lockfile
bun run check
cd packages/cluster
bun run test
```

Integration checks need additional local services. A
[GitHub Actions template](packages/cluster/ci/README.md) is included but inactive.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the inherited development conventions.

## Credits

opencode-cluster is an independent project. It is not built by or affiliated with
the OpenCode team. OpenCode is developed by
[Anomaly](https://github.com/anomalyco/opencode); the upstream
[documentation](https://opencode.ai/docs) and
[README](https://github.com/anomalyco/opencode/blob/v2.0.32/README.md) cover the
original project.

Code retains the [MIT license](LICENSE). The bubbly wordmark uses
[DynaPuff](packages/cluster/assets/README.md), with its font license included.
