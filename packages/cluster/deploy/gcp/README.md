# Google Cloud Run profile

Build the same OCI control-plane and executor images used by Compose. Deploy PostgreSQL
(for example Cloud SQL) and the API service in `us-east4`. Use private connectivity
and Secret Manager for the database URL and application passwords.

`service.yaml` is an API template, not a provisioned installation. It deliberately
contains required substitutions. Review Cloud SQL connection limits before raising
API instance count: each process currently has a 16-connection pool.

Run one execution worker per namespace with `CLUSTER_ROLE=worker`. It requires
continuous CPU and a durable supervisor; request-based billing with a zero minimum
instance count is unsuitable. Use a separately supervised Cloud Run Instance or a
service with instance-based CPU, minimum/maximum instances of one, and controlled
rollouts. A replacement worker must acquire the PostgreSQL lease. During rollout,
the old owner may still run external tools; stop its executor before admitting new
work. Database fencing cannot undo a command already sent to an external service.

The executor requires an isolated Linux environment and durable `/workspace`
storage. Mount Filestore or another qualified POSIX volume into the executor,
not into SQLite. SQLite images are stored transactionally in PostgreSQL. Do not
share an executor workspace between independent installations without isolation.

Cloud Run **sandboxes** (Preview, `--sandbox-launcher`) can be evaluated as an
execution isolation adapter. They share their host instance's CPU and memory and
do not provide durable workspaces or solve per-agent process overhead. This
repository's HTTP execution interface provides the adapter boundary; the new
sandbox launcher has not been integrated or deployed here.

Cloud Run **Instances** are a separate Preview feature. Do not confuse their
lifecycle with request-driven API services or sandbox launchers.

No live GCP resources are created by this repository. Qualify regions, quotas,
private network access, execution isolation, shutdown and volume fencing before
using personal data.

References:

- [Cloud Run sandboxes](https://docs.cloud.google.com/run/docs/configuring/services/sandboxes)
- [Cloud Run to Cloud SQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run)
