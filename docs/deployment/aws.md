# Running it on AWS

The design in `docs/architecture/README.md`, built: the three apps and
the API on ECS Fargate behind a load balancer with HTTPS, a managed
PostgreSQL database, deploys from GitHub Actions with no stored
credentials, and alarms that email you. All of it is Terraform, in
`infra/terraform/`.

It is still a prototype with simulated money. This makes it *run* like
a production service; it doesn't make it one, and
`docs/architecture/README.md` lists what would.

## What gets built

```
                         Route 53  app. / till. / admin.<your domain>
                             │
                   ┌─────────▼──────────┐
   internet ──────▶│   load balancer    │  HTTPS (ACM certificate), HTTP → HTTPS
                   └───┬────────────┬───┘
            /api/*     │            │   everything else, by host name
                ┌──────▼─────┐  ┌───▼──────────────────────┐
                │    API     │  │ consumer · merchant ·    │   ECS Fargate,
                │  (1–3)     │  │ admin (nginx, on Spot)   │   public subnets
                └──────┬─────┘  └──────────────────────────┘
                       │
                ┌──────▼─────┐
                │ PostgreSQL │   RDS, private subnets, no internet route
                └────────────┘

   GitHub Actions ──OIDC──▶ deploy role ──▶ ECR · ECS
   CloudWatch alarms · GuardDuty · failed deployments ──▶ SNS ──▶ your email
```

| File in `infra/terraform/app/` | What it is |
| --- | --- |
| `network.tf` | VPC, two public and two private subnets across two zones |
| `security_groups.tf` | internet → load balancer → API → database, and nothing that skips a step |
| `dns_tls.tf` | Certificate and DNS records |
| `alb.tf` | Listeners and routing, including the address restriction on admin |
| `ecs.tf` | Cluster, task definitions, services, autoscaling, automatic rollback |
| `rds.tf` | The database |
| `secrets.tf` | Database URL and signing secret, generated and stored encrypted |
| `iam.tf` | Roles for the containers, written out permission by permission |
| `monitoring.tf` | Alarms, the dashboard, the alert topic |
| `guardduty.tf` | Threat detection, with findings sent to the same place |

## Before you start

- An AWS account, and the AWS CLI signed in as an administrator
  (`aws sts get-caller-identity` should answer).
- Terraform 1.10 or newer.
- **A domain in Route 53.** HTTPS needs a certificate and a certificate
  needs a name, and the API refuses to run in production without HTTPS.
  Either register a domain in Route 53, or create a hosted zone for a
  subdomain of one you own and point its NS records at it.
- This repository pushed to GitHub, with CI passing.

## First-time setup

Commands are the same in PowerShell, Git Bash or a Mac/Linux terminal.

**1. Bootstrap** — state bucket, image repositories, deploy role, budget.

```
cd infra/terraform/bootstrap
copy terraform.tfvars.example terraform.tfvars     (cp on Mac/Linux; then edit it)
terraform init
terraform apply
```

Note the two outputs, `state_bucket` and `deploy_role_arn`. Confirm the
budget email AWS sends.

**2. Tell GitHub which role to use.** In the repository: Settings →
Secrets and variables → Actions → **Variables** tab → New repository
variable:

- `AWS_DEPLOY_ROLE_ARN` = the `deploy_role_arn` output

It is a variable rather than a secret because it isn't one: the role can
only be assumed by this repository's `main` branch, so knowing its name
gets nobody anywhere.

**3. Build the images.** Actions → Deploy → Run workflow. It builds and
pushes all four images, sees there is nothing to deploy to yet, and
stops successfully.

**4. Build the environment.**

```
cd infra/terraform/app
copy terraform.tfvars.example terraform.tfvars     (then edit it)
terraform init -backend-config="bucket=<state_bucket output>"
terraform apply
```

About ten to fifteen minutes, most of it the database. Confirm the alert
subscription email, or no alarm will ever reach you.

**5. First deploy.** Add one more repository variable, `APP_URL`, set to
the `app_url` output, then run the Deploy workflow again. This time it
applies the database migrations and rolls every service onto the commit
it built. Until this has run the database is empty and sign-up will
fail.

**6. Make yourself an admin.** Register an account in the consumer app,
then Actions → "Ops: promote an admin" → Run workflow with that email.
Sign out and in again, and open the admin app from an address in
`admin_allowed_cidrs`.

Commit `.terraform.lock.hcl` from both stack folders. Never commit
`terraform.tfvars` or any `.tfstate` file; `.gitignore` already excludes
them.

## Day to day

**Deploying** is pushing to `main`. CI runs; if it passes, Deploy builds
the images, applies migrations once, rolls the services and checks the
result from outside. If the new version never becomes healthy, ECS puts
the old one back by itself, the workflow fails, and you get an email.

**Changing infrastructure** is editing Terraform and running
`terraform plan` then `terraform apply` in `infra/terraform/app`. A
change to a container's settings (an environment variable, its memory)
takes effect at the next deploy, because the pipeline decides which
version runs — run the Deploy workflow to roll it out now.

**Looking at it:**

- The dashboard: `terraform output dashboard_url`.
- API logs: CloudWatch → Log groups → `/ecs/fintech-network-prod/api`.
  Every line is JSON with a `reqId`, the same id the app shows a user in
  an error, so one search finds their request.
- Live tail from a terminal:
  `aws logs tail /ecs/fintech-network-prod/api --follow`

**Rolling back by hand** is re-running the Deploy workflow run for the
last good commit (Actions → that run → Re-run all jobs). It works
because migrations are additive: the old code still runs against the
new schema.

## What it costs, and turning it off

Rough figures for London (eu-west-2), left running all month. Check
them against the AWS Pricing Calculator before relying on them.

| | About, per month |
| --- | --- |
| Load balancer | $20 |
| Public IPv4 addresses (2 on the load balancer, 1 per container) | $22 |
| API container (0.25 vCPU, 0.5 GB) | $10 |
| Three front-end containers on Spot | $9 |
| Database (`db.t4g.micro`, 20 GB) | $16 |
| DNS zone, alarms, logs, GuardDuty after its 30-day trial | $3–6 |
| **Total** | **roughly $80, or $2.60 a day** |

So don't leave it running all month. The budget in the bootstrap stack
is set to $30 on purpose: if you forget it's up, you hear about it in
the second week rather than on the invoice.

**Turn it off** when you aren't using it:

```
cd infra/terraform/app
terraform destroy
```

That removes everything that costs real money, including the database
and its data (which is synthetic). What stays — images, state, the
deploy role, the budget — costs well under a dollar a month, plus $0.50
for the hosted zone.

**Turn it back on** with `terraform apply`, then run the Deploy workflow
to apply migrations to the new, empty database.

Cheaper while it's up: `web_apps = ["web-consumer"]` in
`terraform.tfvars` drops two containers and two addresses.

## Decisions worth being able to explain

- **Containers in public subnets.** The textbook answer is private
  subnets and a NAT gateway; a NAT gateway is about $35 a month before
  data. Here the containers have public addresses but their security
  groups accept connections from the load balancer only, and the
  database has no internet route at all. To do it the textbook way: add
  private app subnets and a NAT gateway (or VPC endpoints for ECR, logs
  and SSM), move the services there, and set `assign_public_ip = false`.
- **One database instance, not two.** `db_multi_az = true` gives a
  standby with automatic failover and doubles the database cost. Off by
  default; turn it on to demonstrate failover, then off again.
- **Parameter Store, not Secrets Manager.** Same encryption, no monthly
  charge per secret. Secrets Manager earns its price with automatic
  rotation, which this doesn't use.
- **Secrets are in the Terraform state.** The generated database
  password and signing secret are stored there, which is why the state
  bucket is private, encrypted, versioned and refuses plain HTTP.
- **The pipeline cannot change infrastructure.** The deploy role can
  push images and roll services. It cannot edit the network, the
  database, IAM or the state. Terraform is applied by a person.
- **`/health` and `/metrics` are not public.** Only `/api/*` is routed
  to the API. The load balancer's health check reaches `/health/ready`
  directly inside the network.
- **Admin is restricted twice**: by source address at the load balancer,
  and by role in the API.
- **The front ends stay as nginx containers** rather than moving to S3
  and CloudFront. That would be cheaper and is what
  `docs/architecture/README.md` sketches; it's a good next change.
- **Metrics come from the load balancer, not the app's `/metrics`.**
  That endpoint is per-instance and nothing scrapes it yet. Managed
  Prometheus, or the Kubernetes step later, is where it gets used.

## What has and hasn't been checked

Both stacks are formatted and pass validation, and have been planned
against a mocked AWS provider in four configurations (all apps, no
admin, consumer only, and the incident drill). That was done with
OpenTofu 1.10, the Terraform-compatible fork, and AWS provider 6.14. The
workflows pass `actionlint`. **None of it has been applied to
a real AWS account yet** — the first `terraform apply` is the real test,
and the places most likely to need a nudge are account-specific: an
existing GitHub OIDC provider or GuardDuty detector (there are variables
for both), and the backup retention limit on free-plan accounts
(`db_backup_retention_days`).
