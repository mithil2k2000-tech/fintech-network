variable "aws_region" {
  description = "Region everything is created in."
  type        = string
  default     = "eu-west-2"
}

variable "project" {
  description = "Short name used as a prefix for every resource."
  type        = string
  default     = "fintech-network"
}

variable "environment" {
  description = "Environment the app stack deploys. Must match the app stack's value: the deploy role's permissions are scoped to these names."
  type        = string
  default     = "prod"
}

variable "github_repository" {
  description = "owner/repo allowed to assume the deploy role."
  type        = string
  default     = "mithil2k2000-tech/fintech-network"
}

variable "github_branch" {
  description = "Only workflow runs on this branch may deploy."
  type        = string
  default     = "main"
}

variable "create_github_oidc_provider" {
  description = "An AWS account can hold only one GitHub OIDC provider. Set false if this account already has one."
  type        = bool
  default     = true
}

variable "images" {
  description = "One ECR repository per image the pipeline builds."
  type        = set(string)
  default     = ["api", "web-consumer", "web-merchant", "web-admin"]
}

variable "monthly_budget_usd" {
  description = "Monthly spend that triggers the budget emails."
  type        = number
  default     = 30
}

variable "budget_alert_email" {
  description = "Where budget warnings are sent."
  type        = string
}
