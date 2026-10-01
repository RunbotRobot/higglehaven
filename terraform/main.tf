# Intentionally empty of resources — this step (#1137) is pure scaffolding
# only: provider + backend + variables, so `terraform init`/`validate` work
# end to end before anything live is ever touched.
#
# Importing the already-live Worker, D1 database, and R2 buckets into this
# state (one at a time, verifying `terraform plan` shows no diff before
# each next one) is #1139's job, not this step's. Bringing the Worker
# Build trigger config under management (the change that actually closes
# out #662) is #1140's.
