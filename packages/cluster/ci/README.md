# GitHub Actions template

Copy `cluster.yml` to `.github/workflows/cluster.yml` at the repository root to
enable the cluster checks. The workflow uses disposable PostgreSQL and Linux
executor containers and synthetic model responses; no provider credentials are
required.

Installing or updating a workflow requires GitHub authentication with permission
to write Actions workflows. The template is inactive until copied into that
location. Local checks remain available through the package scripts.
