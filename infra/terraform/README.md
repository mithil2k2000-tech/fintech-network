# Infrastructure

The AWS environment for this app, as code. Two stacks:

| Stack | What it holds | Lifetime |
| --- | --- | --- |
| `bootstrap/` | Terraform state bucket, image repositories, the GitHub deploy role, the budget | Created once, kept. Costs pennies. |
| `app/` | Network, load balancer, containers, database, monitoring, GuardDuty | Created and destroyed as needed. This is the part that costs money. |

They are separate so that tearing the app down to save money doesn't
throw away the images or the pipeline's access — bringing it back is one
`terraform apply`.

Start with `docs/deployment/aws.md`.
