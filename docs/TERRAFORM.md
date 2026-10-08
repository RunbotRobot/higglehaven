# Terraform adoption (issue #1136)

Tracking doc for the Terraform-adoption tracking issue (#1136). This file
holds the API token scoping work from #1138; later sub-issues (#1137
scaffold, #1139 import, #1140 Build trigger, #1141 apply workflow) should
extend this doc rather than starting a separate one.

## Resources in scope

Everything Terraform needs to manage, per #1136's design sketch, matched
against what's actually live in this account today (`wrangler.jsonc`):

| Resource | Current state | Terraform-managed? |
| --- | --- | --- |
| Worker script `higglehaven` | Live, deployed via Workers Builds (Git-connected) | Yes (#1137/#1139) |
| D1 database `higglehaven-db` (`3d9ad5a2-7529-4fd2-9b2f-60604b0499a1`) | Live | Yes (#1139) |
| R2 bucket `higglehaven-models` | Live | Yes (#1139) |
| R2 bucket `higglehaven-db-backups` | Live | Yes (#1139) |
| R2 bucket for Terraform's own remote state | Does not exist yet | Created by #1137, referenced as the backend |
| Worker Build trigger (Git integration: repo, branch, build command, deploy command) | Live, dashboard-configured; this is the #662 root cause | Yes (#1140) |
| Cron Triggers (`*/10 * * * *`, `0 3 * * *`) | Live, in `wrangler.jsonc` | Yes (#1139) |
| KV namespace | **None exist** — grep across the repo finds no `kv_namespaces` binding anywhere | Not in scope today; see note below |
| Custom domain routes (`higglehaven.com`, `www.higglehaven.com`) | Live, in `wrangler.jsonc` | **Not** in #1136's design sketch — out of scope for now, see note below |

Note on KV: #1136's own wording ("KV/R2 resources") is generic/forward-looking —
there is no live KV namespace to import. Don't request KV permissions
up front on that basis alone; add them when a sub-issue actually needs
to create or import one.

Note on custom domain routes: these aren't mentioned in #1136's design
sketch and importing them pulls in zone-level permissions (`Zone` >
`Workers Routes` > `Edit`, scoped per zone) that nothing else in this
plan needs. Leaving them out keeps the token to account-level
permissions only. If a later sub-issue wants Terraform to manage the
custom domain too, scope that permission then, separately.

## Exact permission list to hand the owner

All of these are **Account**-scoped permission groups (not User-level,
not Zone-level), created against this account only — never `All
accounts`. One token covers everything below; there's no need for
separate tokens per resource type.

| Permission group | Level | Why |
| --- | --- | --- |
| **D1 Edit** | Account | Import and manage the `higglehaven-db` database (#1139). Terraform's own D1 resource needs write access even just to read current config during `plan` refreshes — `Edit`, not `Read`, per Cloudflare's own token docs (D1 has no read-only resource-management tier separate from Edit). |
| **Workers Scripts Edit** | Account | Import and manage the `higglehaven` Worker script/version/deployment resources (#1137, #1139). This almost certainly also gates the Build-trigger/Git-integration settings (#1140), since those live under the Worker's own `Settings > Builds` panel in the dashboard — but Cloudflare's docs don't show a Terraform resource or a separate permission group specifically for Git-integration config as of this writing (see "Open question" below), so treat this as the best current guess, to be confirmed when #1140 is actually implemented. |
| **Workers R2 Storage Write** (Edit) | Account | Two uses: (1) manages the `higglehaven-models` bucket as a Terraform resource (#1139), and (2) the same token doubles as the R2 **S3-API credential** for Terraform's own remote state backend (#1137) — R2's S3-compatible API derives the Access Key ID from the token's `id` and the Secret Access Key from a SHA-256 hash of the token value, so no separate R2-specific token is needed as long as this permission is present. |

That's the complete list — three permission groups, one token, account-scoped.
No Zone permissions, no Account Settings, no Account Analytics, no API
Tokens management permission (Terraform doesn't need to create more
tokens on your behalf).

## Open question for #1140: is Build-trigger config Terraform-manageable at all?

As of this writing, Cloudflare's own documentation (`/workers/platform/infrastructure-as-code/`,
the `cloudflare_workers_script`/`cloudflare_worker`/`cloudflare_worker_version`/
`cloudflare_workers_deployment` resource docs) describes managing a
Worker's code, bindings, and deployments via Terraform, but nothing
describing a Terraform resource for the Git-integration / Build-trigger
settings (repo connection, build command, deploy command) that `#662`'s
fix actually lives in. It's possible this genuinely isn't exposed via
the Cloudflare provider yet, in which case #1140 may need to fall back
to a `null_resource`/`local-exec` wrapper around the existing Build
Configuration API, or simply document that piece as staying
dashboard-managed with the rest brought under Terraform. Whoever picks
up #1140 should confirm current provider support first rather than
assuming "Workers Scripts Edit" covers it just because this doc guessed
that.

## How the owner should create the token

Dashboard → My Profile → API Tokens → Create Token → Custom token, with:
- Permissions: `Account` / `D1` / `Edit`, `Account` / `Workers Scripts` / `Edit`,
  `Account` / `Workers R2 Storage` / `Edit`
- Account Resources: `Include` / the Higglehaven account only
- Zone Resources: none needed — remove the default "All zones" row
- No IP address filtering or TTL constraints needed beyond Cloudflare's
  defaults, unless the owner wants to add their own extra restriction

Once created, store it as `CLOUDFLARE_API_TOKEN` wherever Terraform
runs (not committed — see #1141 for where "runs" ends up meaning).
