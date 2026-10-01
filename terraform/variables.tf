# Scoping out exactly which permissions this token needs is #1138's own
# task — until that lands, any token with read/edit access to the specific
# higglehaven Worker, D1 database, and R2 buckets this config manages is
# enough to run `terraform plan`/`apply` here.
variable "cloudflare_api_token" {
  description = "Cloudflare API token, scoped per issue #1138. Never committed — pass via TF_VAR_cloudflare_api_token or a gitignored terraform.tfvars."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the higglehaven resources. This account also hosts several unrelated projects (other Workers/R2 buckets) — every resource this config manages must stay scoped to higglehaven's own, never account-wide."
  type        = string
}
