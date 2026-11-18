# Infrastructure (AWS)

Terraform creates one EC2 server per environment. Each server runs
`deploy/compose.yaml`, the same stack you run locally with podman, with the
images CI built (see "Images" in [`deploy/README.md`](../deploy/README.md#images)).
QA and PROD differ only in the values in `envs/<env>/main.tf` and in each
server's `deploy/.env`.

```
infra/
  modules/app_server/   the server: Ubuntu 24.04, Docker + Compose, firewall, fixed IP
  envs/qa/              QA values + QA state
  envs/prod/            PROD values + PROD state (termination protection, S3 backups)
  tf.sh                 runs Terraform from a pinned container image
  server.sh             deploys the app on a server and saves its data, over SSH
```

What gets created per environment: an EC2 instance (t3.small, 30 GB encrypted
disk), a security group (80/443 open, 22 only from your addresses), an SSH key
pair, and an Elastic IP. All in the account's default VPC. Cost is roughly
$20/month per environment, mostly the instance; check current AWS pricing.

Both scripts run on the host (they need podman and SSH). `tf.sh` needs the AWS
keys in your shell; `server.sh` needs only SSH. Run them from `infra/`.

## Server addresses

There is no domain yet. A server's address is
`<public_ip with dashes>.sslip.io`, e.g. `https://3-120-45-67.sslip.io` for
3.120.45.67: that name resolves to the IP, so Caddy can still get a real
Let's Encrypt certificate. `server.sh` sets it as `SITE_ADDRESS`. The Elastic
IP survives stops and starts, so the URL changes only when the server is
destroyed and created again. To print a server's IP:

```
./tf.sh qa output -raw public_ip
```

## One-time setup (by hand)

1. **AWS account.** In IAM, create a user for Terraform (not the root
   account) with the `AmazonEC2FullAccess` policy, and create an access key for it.
   PROD also creates an S3 bucket and an IAM role for its backups: before
   `./tf.sh prod apply`, add `terraform-backups-policy.json` to that user as an
   inline policy (Add permissions -> Create inline policy -> JSON), with
   `<ACCOUNT_ID>` replaced by your account ID. It allows only resources named
   `entitynetworks-*`.
2. **Credentials in your shell** (only for the session where you run Terraform;
   `tf.sh` also passes `AWS_SESSION_TOKEN` if set):
   ```
   export AWS_ACCESS_KEY_ID=...
   export AWS_SECRET_ACCESS_KEY=...
   ```
3. **Personal values**, per environment (then edit the file):
   ```
   cp envs/qa/terraform.tfvars.example envs/qa/terraform.tfvars
   ```

## Create QA

```
./tf.sh qa init
./tf.sh qa plan
./tf.sh qa apply
```

`init` downloads the AWS provider the first time and writes
`.terraform.lock.hcl` (commit it). `plan` shows what would be created and
changes nothing. `apply` creates it after you type "yes" and prints `public_ip`
and `ssh`.

Then set up the app with `./server.sh qa deploy` (below). It waits for the
server's first-boot setup (cloud-init, 2-3 minutes) by itself.

## `server.sh`: deploy and save

```
./server.sh <qa|prod> deploy [--restore <dir>] [--ref <git ref>] [--smtp] [--yes] [--ip <address>]
./server.sh <qa|prod> save
```

`./server.sh` without arguments prints this help.

| Option | |
|---|---|
| `--ref <git ref>` | what to deploy. Default: `origin/main` for QA, the commit QA runs for PROD |
| `--restore <dir>` | after starting, restore the `db-*.dump` and `uploads-*.tar.gz` in `<dir>` |
| `--smtp` | ask for the email (SMTP) settings again |
| `--yes` | don't ask before deploying to PROD or restoring |
| `--ip <address>` | server IP; default `public_ip` from `envs/<env>/terraform.tfstate` |

Environment: `REPO_URL` (the git URL the server clones, default the public
GitHub repo), `IMAGE_PREFIX` (default `ghcr.io/milo80/`), `SAVE_DIR` (where
`save` puts backups, default `envs/<env>/backups`).

**`deploy`** does the steps of "First deployment to a server" in
[`deploy/README.md`](../deploy/README.md#first-deployment-to-a-server-by-hand),
over SSH. It waits for SSH and first-boot setup, clones the repo into
`/opt/entitynetworks`, and pulls CI's images for `--ref`. If they don't exist
(CI hasn't passed on that commit), it stops before changing anything. Then it
checks out the commit and writes `.env` with the server address and a newly
generated database password (the secret is created on the server and never
copied). On a new server, or with `--smtp`, it asks for the SMTP settings for
password reset links (see "Email" in
[`deploy/README.md`](../deploy/README.md#email-password-reset)); leave the host
empty for none. It then starts the stack, restores the backup if one is given,
adds the daily backup cron job and waits for `/api/health`. Without `--restore`
the database is empty, and the script prints the `create-user` command for the
first admin.

Running `deploy` again on a running server updates it: it backs up first, checks
out `--ref`, switches to its images and keeps `.env`. So `deploy --smtp` also
deploys `--ref`. To change only the email settings, pass the commit the server
runs now (its `TAG` in `deploy/.env`) as `--ref`.

**`save`** runs `backup.sh` on the server and copies both files to
`envs/<env>/backups/<time>/` on this machine. It needs only SSH. The saved
files hold password hashes: they're owner-only and git-ignored, and they stay
on this machine.

## Save and rebuild QA

`./tf.sh qa destroy` deletes the server's disk. That loses the database (all
accounts and datasets), the uploads, the backups kept on the server, its `.env`
and its certificate. It also releases the IP, so the next apply gets a new IP and
a **new URL**. To keep the accounts and data across a rebuild:

```
./server.sh qa save
./tf.sh qa destroy
./tf.sh qa apply
./server.sh qa deploy --restore envs/qa/backups/<time>
```

`save` prints the directory to pass to `--restore`. A new server asks for the
SMTP settings again.

## PROD

PROD uses the same module and the same scripts. It differs in three ways:

- **Promotion, not `origin/main`.** `./server.sh prod deploy` deploys the commit QA
  runs now (read from QA's `.env`) and asks before changing anything. Deploy to QA
  first, test there, then promote. `--ref <commit>` overrides this (CI must have
  published images for that commit).
- **Termination protection.** Deleting the server first needs
  `termination_protection = false` in `envs/prod/main.tf` and an apply.
- **Off-server backups.** `offsite_backups = true` creates an S3 bucket
  (`entitynetworks-prod-backups-<account id>`, private, copies expire after 30 days)
  and an IAM role for the server that may only *add* files to it, not list, read or
  delete them. `server.sh` writes the bucket into `.env` as `BACKUP_S3_URI`, and
  `backup.sh` copies each backup there (see "Off-server copies" in
  [`deploy/README.md`](../deploy/README.md#off-server-copies-s3)).
  `./tf.sh prod destroy` can't delete a bucket that holds backups.

Create it (after step 1 of the one-time setup, including the inline policy):

```
cp envs/prod/terraform.tfvars.example envs/prod/terraform.tfvars
./tf.sh prod init
./tf.sh prod apply
./server.sh prod deploy
```

`apply` prints `public_ip` and `backup_bucket`. Then create the admin as
`deploy` prints it (see "Accounts on a server" in
[`deploy/README.md`](../deploy/README.md#accounts-on-a-server)).

To restore PROD from S3, download a backup as described in "Off-server copies"
in [`deploy/README.md`](../deploy/README.md#off-server-copies-s3), then
`./server.sh prod deploy --restore <dir>`. `./server.sh prod save` also keeps
a copy of the latest backup on this machine.

## The state files

`envs/<env>/terraform.tfstate` is how Terraform knows what it created. It is
git-ignored and exists only on this machine: back it up. If it's lost,
Terraform will try to create everything again (the existing resources must
then be imported or deleted in the AWS console). Moving the state to S3 comes
with the CI work, when CI runs Terraform.
