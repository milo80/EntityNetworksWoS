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
   PROD also creates an S3 bucket and an IAM role for its backups: before
   `./tf.sh prod apply`, add `terraform-backups-policy.json` to that user as an
   inline policy (Add permissions -> Create inline policy -> JSON), with
   `<ACCOUNT_ID>` replaced by your account ID. It allows only resources named
   `entitynetworks-*`.
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

Then set up the app with `./server.sh qa deploy` (below). It does the steps of
`deploy/README.md`, "First deployment to a server", using
`<public_ip with dashes>.sslip.io` (e.g. `3-120-45-67.sslip.io`) as `SITE_ADDRESS`.
That name resolves to the IP, so Caddy can still get a real certificate without
a domain.

## Set up, save and rebuild QA: `server.sh`

`./tf.sh qa destroy` deletes the server's disk. That loses the database (all
accounts and datasets), the uploads, the backups kept on the server, its `.env`
and its certificate. It also releases the IP, so the next apply gets a new IP and
a **new URL**. To keep the accounts and data across a rebuild:

```
./server.sh qa save                          # backup on the server, copied to envs/qa/backups/<time>/
./tf.sh qa destroy                           # on the host
./tf.sh qa apply                             # on the host, later
./server.sh qa deploy --restore envs/qa/backups/<time>
```

`deploy` waits for first-boot setup, clones the repo into `/opt/entitynetworks`,
checks out `--ref` (default `origin/main`), pulls the images CI built and tested for
that commit (it never builds on the server, so CI must have passed on it), and writes `.env` with a newly generated
database password (the secret is created on the server and never copied). On a new
server it also asks for the email (SMTP) settings for password reset links; leave the
host empty for none, and use `--smtp` to set or change them later. It then
starts the stack, restores the backup if one is given, adds the daily
backup cron job and waits for `/api/health`. Without `--restore` the database is
empty, and the script prints the `create-user` command for the admin.

Running `deploy` again on a running server updates it: it backs up first, checks
out `--ref` and switches to its images, and keeps `.env`. `save` needs only SSH. The saved files
hold password hashes: they're owner-only and git-ignored, and they stay on this
machine.

## PROD

PROD uses the same module and the same scripts. It differs in three ways:

- **Promotion, not `origin/main`.** `./server.sh prod deploy` deploys the commit QA
  runs now (read from QA's `.env`) and asks before changing anything. Deploy to QA
  first, test there, then promote. `--ref <commit>` overrides this (CI must have
  published images for that commit).
- **Termination protection.** Deleting the server first needs
  `termination_protection = false` and an apply.
- **Off-server backups.** `offsite_backups = true` creates an S3 bucket
  (`entitynetworks-prod-backups-<account id>`, private, copies expire after 30 days)
  and an IAM role for the server that may only *add* files to it, not list, read or
  delete them. `server.sh` writes the bucket into `.env` as `BACKUP_S3_URI`, and the
  daily `backup.sh` uploads both files. `./tf.sh prod destroy` can't delete a bucket
  that holds backups.

No domain yet: like QA, PROD is at `https://<ip with dashes>.sslip.io`. Its Elastic
IP survives stops and starts, so the URL only changes if the server is destroyed.

```
cp envs/prod/terraform.tfvars.example envs/prod/terraform.tfvars   # then edit it
./tf.sh prod init
./tf.sh prod apply                       # on the host; prints public_ip, backup_bucket
./server.sh prod deploy                  # QA's commit; asks for the SMTP settings
ssh -t ubuntu@<public_ip> 'cd /opt/entitynetworks/deploy && docker compose exec api python -m app.manage create-user you@example.org --admin'
```

To restore PROD from S3, download a `db-<time>.dump` and its `uploads-<time>.tar.gz`
(S3 console -> the bucket -> Download) into a new directory, then
`./server.sh prod deploy --restore <dir>`. `./server.sh prod save` also copies the
latest backup to `envs/prod/backups/<time>/` on this machine.

## The state files

`envs/<env>/terraform.tfstate` is how Terraform knows what it created. It is
git-ignored and exists only on this machine: back it up. If it's lost,
Terraform will try to create everything again (the existing resources must
then be imported or deleted in the AWS console). Moving the state to S3 comes
with the CI work, when CI runs Terraform.
