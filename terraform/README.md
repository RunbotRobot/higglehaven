# Terraform (Cloudflare infrastructure)

Tracking issue: #1136. This directory adopts Terraform (the official
`cloudflare/cloudflare` provider) so Cloudflare-side configuration for this
project — the Worker, D1 database, R2 buckets, and the Worker's Build
trigger deploy command (the root cause of #662) — becomes code applied
through Cloudflare's own API, rather than a dashboard-only manual step.

## This step (#1137): scaffolding only

This step adds the provider, remote state backend, and variable
declarations. It does **not** declare, import, or change any existing live
resource — no `cloudflare_*` resource blocks exist yet. That's #1139's job
(importing the Worker/D1/R2 resources one at a time, verifying
`terraform plan` shows no diff before each next one — a mismatched import
can destroy or recreate a live resource, so it's deliberately not bundled
into this scaffolding step).

## Important: this is a shared Cloudflare account

The Cloudflare account that owns higglehaven's Worker/D1/R2 resources also
hosts several unrelated projects (other Workers and R2 buckets with no
connection to higglehaven). Every resource this config ever manages must
stay scoped to higglehaven's own resources specifically — never an
account-wide data source or a blanket import — so a `terraform apply` here
can never affect another project's infrastructure.

## One-time bootstrap (already done for this state bucket)

Terraform's own remote-state bucket (`higglehaven-terraform-state`, an R2
bucket) was created directly via the Cloudflare API as a one-time step, not
by this Terraform config itself — a backend can't manage the very bucket
it stores its own state in without a chicken-and-egg problem. If this
bucket ever needs recreating, create a fresh R2 bucket of that name before
running `terraform init` again; nothing else here depends on this being
automated.

## Setup

1. **Cloudflare API token** (for the provider itself) — scoping this is
   #1138's own task; the owner creates the actual token in the dashboard.
2. **R2 access keys** (for the state backend, a separate credential type
   from the token above) — generate via the dashboard's R2 > Manage API
   tokens, then export:
   ```sh
   export AWS_ACCESS_KEY_ID=<R2 access key id>
   export AWS_SECRET_ACCESS_KEY=<R2 secret access key>
   ```
3. Copy `backend.hcl.example` to `backend.hcl` (gitignored) and fill in the
   real Cloudflare account id.
4. Copy `terraform.tfvars.example` to `terraform.tfvars` (gitignored), or
   set `TF_VAR_cloudflare_api_token` / `TF_VAR_cloudflare_account_id`
   directly so the token never touches a file at all.
5. ```sh
   terraform init -backend-config=backend.hcl
   terraform plan
   ```
   With no resource blocks yet, `plan` should report no changes.

## Layout

- `versions.tf` — Terraform/provider version constraints.
- `provider.tf` — the `cloudflare` provider block.
- `variables.tf` — `cloudflare_api_token` (sensitive), `cloudflare_account_id`.
- `backend.tf` — the remote-state backend (R2, via Terraform's native
  S3-compatible `s3` backend), with the account-specific/secret parts
  supplied separately — see `backend.hcl.example`.
- `main.tf` — intentionally empty for now; see "This step" above.
