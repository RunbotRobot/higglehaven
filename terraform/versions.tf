terraform {
  required_version = ">= 1.6.0" # 1.6+ for native S3-compatible backend support (R2)

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}
