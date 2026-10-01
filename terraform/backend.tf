# Remote state in a dedicated R2 bucket (higglehaven-terraform-state),
# created once out-of-band via the Cloudflare API rather than by this same
# config, to avoid the chicken-and-egg problem of a backend managing the
# bucket it stores its own state in.
#
# R2 is S3-compatible, so Terraform's native "s3" backend (>= 1.6) works
# against it directly. The account-specific endpoint URL and the R2 access
# keys are NOT set here — they're account-specific and/or secret, and a
# Terraform backend block can't reference variables. Supply them at
# `terraform init` time instead, e.g.:
#
#   terraform init -backend-config=backend.hcl
#
# with a gitignored backend.hcl (see backend.hcl.example) holding:
#   endpoints = { s3 = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com" }
#
# and R2 access-key credentials (a separate credential type from the
# Cloudflare API token above — generated via the dashboard's own "R2 >
# Manage API tokens", the same kind of one-time manual/owner step #1138
# calls out for the main Cloudflare API token) via the standard
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY environment variables, which
# the S3 backend honors natively.
terraform {
  backend "s3" {
    bucket = "higglehaven-terraform-state"
    key    = "higglehaven.tfstate"
    region = "auto" # R2 has no regions; "auto" satisfies the backend's own validation

    # R2 isn't actually S3, so skip the AWS-specific checks/behavior that
    # don't apply or would otherwise fail against it.
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}
