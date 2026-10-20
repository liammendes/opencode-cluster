# Deploy on Google Cloud Run

This guide runs the API and agent workers on Cloud Run. PostgreSQL stores shared session state, and a separate Linux executor stores workspace files and runs tools.

Try the [native Docker setup](../README.md) first if you have not used the cluster before. This is an alpha deployment with a serialized database backend; adding workers does not establish capacity for thousands of active agents.

## What you will deploy

| Component                     | Starting configuration                              | Purpose                                                            |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| API service                   | 1 CPU, 2 GiB, 1–3 instances                         | Accept requests and read shared state.                             |
| Worker service                | 1 CPU, 2 GiB, one instance, CPU always allocated    | Run up to four top-level session families per instance.            |
| Capacity controller, optional | One instance, CPU always allocated                  | Adjust workers from one to four using queue, CPU and RAM metrics.  |
| PostgreSQL                    | A dedicated database and role                       | Store session history, credentials, leases and coordination state. |
| Linux executor                | Separate host or container with a persistent volume | Run shell, file and Git tools.                                     |

PostgreSQL may be Cloud SQL, PlanetScale Postgres, or another compatible service. Cloudflare is optional. It is only one possible DNS provider for your custom domain.

## Before you start

You need:

- A Google Cloud project with billing, `gcloud`, and permission to create Cloud Run, Artifact Registry and Secret Manager resources.
- PostgreSQL reachable from Cloud Run. Use a database and role dedicated to this installation.
- A private executor endpoint and a persistent workspace volume. Cloud Run's writable container filesystem is not a workspace backup.
- A domain you control, plus a load balancer and certificate budget.
- A model provider account. The cluster does not bypass its rate limits.

Choose a region near the database and executor. Keep storage, backups and execution within any residency boundary your deployment requires.

Run repository commands from the root checkout. Replace these examples:

```sh
export PROJECT=your-project
export REGION=us-central1
export REPOSITORY=opencode-cluster
export TAG=your-release-tag
export RUNTIME_SA=opencode-cluster@"$PROJECT".iam.gserviceaccount.com
export NETWORK=your-vpc
export SUBNET=your-subnet
export EXECUTION_URL=http://PRIVATE_EXECUTOR_IP:8081
```

## 1. Prepare the database, executor and secrets

The runtime needs permission to create its two PostgreSQL tables. Start with four database connections per process. Include all API, worker and controller instances when checking database connection limits.

For **PlanetScale Postgres**, create a logical database and a dedicated role inside your existing cluster. Grant that role `CONNECT` to the database and `USAGE, CREATE` on its application schema. Use a connection URL ending in the database name with `sslmode=verify-full`; the pooled endpoint uses port `6432`. Do not reuse a role with broad access to other applications.

For **Cloud SQL**, use the Cloud SQL connector. Grant the runtime service account Cloud SQL Client, attach the instance to each API and worker service, and set:

```text
CLUSTER_DATABASE_SOCKET=/cloudsql/PROJECT:REGION:INSTANCE/.s.PGSQL.5432
```

The database URL still provides the username, password and database name. The [Cloud SQL connection guide](https://docs.cloud.google.com/sql/docs/postgres/connect-run) covers connector configuration.

Build and run the executor from `packages/cluster/deploy/executor.Dockerfile` on your supervised Linux host. Give it `EXECUTION_TOKEN`, `WORKSPACE_ROOT` and a writable workspace volume. Mount that volume at the absolute directory clients will use, such as `/workspace`.

Use a non-root user, bounded CPU and memory, dropped capabilities and a read-only image. Do not mount host credentials, home directories or a Docker socket. Block access to the host's cloud metadata endpoint. Restrict the executor port to your Cloud Run network tag through the VPC firewall.

Create these Secret Manager secrets from private files:

| Secret name                | File contents                                             |
| -------------------------- | --------------------------------------------------------- |
| `opencode-database-url`    | PostgreSQL connection URL.                                |
| `opencode-password`        | Random password for API clients.                          |
| `opencode-execution-token` | The same token used by the executor.                      |
| `opencode-config`          | OpenCode v2 JSON with model and shared MCP configuration. |

For example:

```sh
gcloud secrets create opencode-password --project="$PROJECT" \
  --replication-policy=user-managed --locations="$REGION" \
  --data-file=/private/path/cluster-password
```

Repeat for the other secrets. Grant `roles/secretmanager.secretAccessor` to `RUNTIME_SA` on these named secrets. Record the secret version numbers you will deploy; pin versions so a restart cannot silently change configuration.

## 2. Build the images

Enable the required APIs and create an Artifact Registry Docker repository if you do not already have one:

```sh
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com --project="$PROJECT"
gcloud artifacts repositories create "$REPOSITORY" --project="$PROJECT" \
  --location="$REGION" --repository-format=docker
gcloud builds submit --project="$PROJECT" --region="$REGION" \
  --config=packages/cluster/deploy/gcp/cloudbuild.yaml \
  --substitutions="_REGION=$REGION,_REPOSITORY=$REPOSITORY,_TAG=$TAG" .
export IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPOSITORY/runtime:$TAG"
```

The build service account needs Artifact Registry write access. The build also publishes an `executor` image with the same tag for your Linux host.

## 3. Deploy the API and worker

The commands below use secret version `1`. Replace it with each version you recorded. Create the runtime service account first if it does not exist.

```sh
gcloud run deploy opencode-cluster-api --project="$PROJECT" --region="$REGION" \
  --image="$IMAGE" --service-account="$RUNTIME_SA" \
  --cpu=1 --memory=2Gi --min=1 --max=3 --concurrency=40 --timeout=3600 \
  --network="$NETWORK" --subnet="$SUBNET" --network-tags=opencode-cluster-run \
  --vpc-egress=private-ranges-only --ingress=internal-and-cloud-load-balancing \
  --no-default-url --allow-unauthenticated \
  --set-env-vars="CLUSTER_ROLE=api,CLUSTER_NAMESPACE=default,CLUSTER_DATABASE_CONNECTIONS=4,EXECUTION_URL=$EXECUTION_URL" \
  --set-secrets="CLUSTER_DATABASE_URL=opencode-database-url:1,CLUSTER_PASSWORD=opencode-password:1,EXECUTION_TOKEN=opencode-execution-token:1,OPENCODE_CONFIG_CONTENT=opencode-config:1"

gcloud run deploy opencode-cluster-worker --project="$PROJECT" --region="$REGION" \
  --image="$IMAGE" --service-account="$RUNTIME_SA" \
  --cpu=1 --memory=2Gi --scaling=1 --no-cpu-throttling \
  --network="$NETWORK" --subnet="$SUBNET" --network-tags=opencode-cluster-run \
  --vpc-egress=private-ranges-only --ingress=internal --no-default-url \
  --no-allow-unauthenticated \
  --set-env-vars="CLUSTER_ROLE=worker,CLUSTER_NAMESPACE=default,CLUSTER_DATABASE_CONNECTIONS=4,CLUSTER_CONCURRENCY=4,CLUSTER_CPU_LIMIT=1,CLUSTER_MEMORY_BYTES=2147483648,EXECUTION_URL=$EXECUTION_URL" \
  --set-secrets="CLUSTER_DATABASE_URL=opencode-database-url:1,CLUSTER_PASSWORD=opencode-password:1,EXECUTION_TOKEN=opencode-execution-token:1,OPENCODE_CONFIG_CONTENT=opencode-config:1"
```

Cloud SQL users must also attach their instance and set the socket variable on both services. API and worker must agree on database, namespace, executor token and OpenCode configuration.

The API's public invoker permission allows requests through the load balancer. **OpenCode still requires its password.** The worker consumes database work and needs no public invoker permission.

## 4. Add a custom HTTPS address

Use a stable address such as `opencode.services.example.com` for clients. Route it to the Cloud Run **service**, so future revisions keep the same address.

Follow Google's [serverless load balancer setup](https://docs.cloud.google.com/load-balancing/docs/https/setup-global-ext-https-serverless) to create:

1. A regional serverless network endpoint group pointing to `opencode-cluster-api`.
2. A global external Application Load Balancer with that group as its backend.
3. A URL-map host rule for your API hostname.
4. A Google-managed certificate, certificate map and HTTPS proxy.
5. An A record pointing your hostname to the load balancer's static IP.

For [DNS certificate authorization](https://docs.cloud.google.com/certificate-manager/docs/deploy-google-managed-dns-auth), publish Google's exact authorization CNAME before requesting the certificate. A certificate marked `PROVISIONING` is not ready; wait for `ACTIVE` and verify HTTPS from a client.

If you want service names under your own GCP namespace, delegate a subdomain such as `gcp.example.com` to Cloud DNS. A hostname such as `SERVICE-PROJECT_NUMBER.REGION.cloudrun.gcp.example.com` can share the same load balancer. This is optional and does not require moving sibling DNS namespaces.

Verify:

```sh
curl -I https://opencode.services.example.com/api/info
curl --fail --user opencode https://opencode.services.example.com/api/info
```

The first request should return `401`; the second should return server information after prompting for the cluster password. Keep the default Cloud Run URL disabled.

## 5. Connect and run a check

Create a session using the executor's workspace directory, following the [native connection steps](../README.md#4-check-shared-state). With `OPENCODE_PASSWORD` set privately:

```sh
opencode --server https://opencode.services.example.com --session SESSION_ID
```

Ask the agent to write and read a small test file. Verify that it survives a worker restart before relying on the deployment. For Paseo, use the [version-pinned overlay](../../integrations/paseo/README.md).

## Optional: scale from one to four workers

Cloud Run's built-in autoscaling uses CPU and HTTP request concurrency; it does not use RAM or disk utilization. Agent workers consume database work, so this profile uses **manual Cloud Run instance counts controlled by a separate process**.

The controller runs with `CLUSTER_ROLE=autoscaler`. Configure:

```text
GOOGLE_CLOUD_PROJECT=your-project
CLUSTER_REGION=your-region
CLUSTER_WORKER_SERVICE=opencode-cluster-worker
CLUSTER_NAMESPACE=default
CLUSTER_CONCURRENCY=4
CLUSTER_MIN_WORKERS=1
CLUSTER_MAX_WORKERS=4
CLUSTER_DATABASE_CONNECTIONS=4
EXECUTION_URL=http://PRIVATE_EXECUTOR_IP:8081
```

Use the same runtime image, one warm instance, CPU always allocated, and the same VPC access. Supply only the database URL and executor token secrets. Give its separate service account:

- `run.services.get` and `run.services.update` on the **worker service**.
- Service Account User on the worker's runtime account.
- `run.operations.get` at project level, so it can wait for a resize to finish. A custom role containing only this permission avoids granting project-wide service administration.

It does not need the cluster password or model credentials. If a resize starts
but the controller logs `403` while waiting, check the operation-read permission.

Set the controller service to `--scaling=1 --no-cpu-throttling`. Manual scaling
keeps the requested number running; Cloud Run rejects service-level `--min` and
`--max` options in this mode. The controller's configured limits bound its worker
resize requests.

The default policy:

- Requests more workers for queued session families, CPU above a 60% target, or RAM above a 75% target.
- Keeps at least one worker and at most four.
- Scales down only after five minutes idle, with new admissions paused during the change.
- Pauses new session families when executor disk usage reaches 90% or available space falls below 1 GiB.

Existing sessions stay with their worker; adding workers helps new work. A single large session may still need more memory. The controller does not expand executor storage, increase provider quotas, or remove the serialized database bottleneck.

Four workers provide **16 top-level session-family slots**. Nested subagents share their parent's worker and can increase the number of active sessions beyond 16.

## Updates, migration and recovery

Stop admitting new work and let agents settle before rolling out a worker or executor change. A stopped worker's remaining sessions are reported as interrupted; check uncertain tool outcomes before resuming them. Database fencing cannot undo a command already sent to an executor.

To move between PostgreSQL providers, stop API and worker writers first. `src/native/migrate-snapshot.ts` copies one namespace to an empty destination and verifies its checksum. It includes credentials, so run it only through private database connections and secret references. Keep the original database for rollback until the new deployment passes the connection, model and file checks.

Back up workspace volumes separately from PostgreSQL. Keep the [public project page](../domain/README.md) separate from your authenticated API.
