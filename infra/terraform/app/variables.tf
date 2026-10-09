# ---- Required: things only you know -----------------------------------

variable "route53_zone_name" {
  description = "A public Route 53 hosted zone in this account, e.g. \"example.com\"."
  type        = string
}

variable "domain_name" {
  description = "Base name the apps hang off, inside that zone. \"fintech.example.com\" gives app.fintech.example.com, till.… and admin.…"
  type        = string
}

variable "alert_email" {
  description = "Where alarms, GuardDuty findings and failed deployments are sent. AWS emails a confirmation link first."
  type        = string
}

variable "admin_allowed_cidrs" {
  description = "IP ranges allowed to reach the admin app and the admin API, e.g. [\"203.0.113.7/32\"]. Empty means nobody: the admin app is not deployed and the admin API answers 403."
  type        = list(string)

  validation {
    # A load balancer rule takes five condition values in total, and one
    # is already spent on the host or path.
    condition     = length(var.admin_allowed_cidrs) <= 4
    error_message = "At most 4 CIDR ranges (an ALB rule holds 5 condition values)."
  }
}

# ---- Naming -----------------------------------------------------------

variable "aws_region" {
  type    = string
  default = "eu-west-2"
}

variable "project" {
  description = "Must match the bootstrap stack."
  type        = string
  default     = "fintech-network"
}

variable "environment" {
  description = "Must match the bootstrap stack."
  type        = string
  default     = "prod"
}

variable "app_name" {
  description = "Display name. Branding is configuration, never logic."
  type        = string
  default     = "FinTech Network"
}

# ---- What runs, and how big -------------------------------------------

variable "image_tag" {
  description = "Tag the services start on. After that the pipeline deploys commit SHAs and Terraform leaves the running version alone."
  type        = string
  default     = "latest"
}

variable "web_apps" {
  description = "Which front ends to run. Each is one small container, so dropping the two you aren't demonstrating is the easiest saving."
  type        = set(string)
  default     = ["web-consumer", "web-merchant", "web-admin"]

  validation {
    condition     = length(setsubtract(var.web_apps, ["web-consumer", "web-merchant", "web-admin"])) == 0
    error_message = "Valid values: web-consumer, web-merchant, web-admin."
  }

  validation {
    condition     = contains(var.web_apps, "web-consumer")
    error_message = "web-consumer is the app itself and must be included."
  }
}

variable "web_use_spot" {
  description = "Run the front ends on Fargate Spot (about 70% cheaper). They are stateless nginx, so an interruption costs a few seconds."
  type        = bool
  default     = true
}

variable "api_cpu" {
  type    = number
  default = 256
}

variable "api_memory" {
  type    = number
  default = 512
}

variable "api_min_count" {
  description = "API tasks when idle. 1 is cheapest; 2 survives the loss of an availability zone."
  type        = number
  default     = 1
}

variable "api_max_count" {
  description = "Ceiling for CPU-based autoscaling. Each task holds a database pool, so this times the pool size must stay under the database's connection limit."
  type        = number
  default     = 3
}

variable "container_insights" {
  description = "Per-task metrics in CloudWatch. Useful, and billed as custom metrics."
  type        = bool
  default     = false
}

# ---- Database ---------------------------------------------------------

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_multi_az" {
  description = "A standby in a second zone with automatic failover. Doubles the database cost; turn on to demonstrate it, off to live with."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Days of point-in-time recovery. Some free-plan accounts only allow 1."
  type        = number
  default     = 7
}

variable "db_deletion_protection" {
  description = "Refuse to delete the database. Off by default because this environment is built to be torn down."
  type        = bool
  default     = false
}

variable "db_skip_final_snapshot" {
  description = "Skip the snapshot on destroy. The data is synthetic; set false if you ever care about it."
  type        = bool
  default     = true
}

# ---- Observability and security ---------------------------------------

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "enable_guardduty" {
  description = "Create a GuardDuty detector. Set false if this account and region already have one (there can only be one)."
  type        = bool
  default     = true
}

# ---- Incident drill ---------------------------------------------------

variable "incident_drill_break_api" {
  description = "Leave false. Setting it true ships a configuration the API refuses to start with, to rehearse a failed release. See docs/deployment/incident-drill.md."
  type        = bool
  default     = false
}
