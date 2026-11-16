# Infrastructure (AWS)

Terraform creates one EC2 server per environment. Each server runs
`deploy/compose.yaml`, the same stack you run locally with podman. QA and PROD
differ only in the values in `envs/<env>/main.tf` and in each server's `deploy/.env`.

```
infra/
  modules/app_server/   the server: Ubuntu 24.04, Docker + Compose, firewall, fixed IP
  envs/qa/              QA values + QA state
  envs/prod/            PROD values + PROD state (termination protection on)
  tf.sh                 runs Terraform from a pinned container image
```

What gets created per environment: an EC2 instance (t3.small, 30 GB encrypted
disk), a security group (80/443 open, 22 only from your addresses), an SSH key
pair, and an Elastic IP. All in the account's default VPC. Cost is roughly
$20/month per environment, mostly the instance; check current AWS pricing.

## One-time setup (by hand)

1. **AWS account.** In IAM, create a user for Terraform (not the root
   account) with the `AmazonEC2FullAccess` policy, and create an access key for it.
2. **Credentials in your shell** (only for the session where you run Terraform):
   ```
   export AWS_ACCESS_KEY_ID=...
   export AWS_SECRET_ACCESS_KEY=...
   ```
3. **Personal values:**
   ```
   cp envs/qa/terraform.tfvars.example envs/qa/terraform.tfvars   # then edit it
   ```

## Create QA

```
./tf.sh qa init      # first time: downloads the AWS provider, writes .terraform.lock.hcl (commit it)
./tf.sh qa plan      # shows what would be created; nothing changes yet
./tf.sh qa apply     # creates it after you type "yes"; prints public_ip and ssh
```

Wait 2-3 minutes for first-boot setup, then check it:
```
ssh ubuntu@<public_ip> 'cloud-init status --wait && docker compose version'
```

Then point the domain's DNS A record at `public_ip` and follow
`deploy/README.md`, "First deployment to a server".

No domain yet? For QA you can use `<public_ip with dashes>.sslip.io` (e.g.
`3-120-45-67.sslip.io`) as `SITE_ADDRESS`: it resolves to that IP, so Caddy
can still get a real certificate.

## PROD

The same steps with `prod` instead of `qa`, once QA works. `termination_protection`
is on for PROD: deleting the server first needs that value set to `false` and an apply.

## The state files

`envs/<env>/terraform.tfstate` is how Terraform knows what it created. It is
git-ignored and exists only on this machine: back it up. If it's lost,
Terraform will try to create everything again (the existing resources must
then be imported or deleted in the AWS console). Moving the state to S3 comes
with the CI work, when CI runs Terraform.
