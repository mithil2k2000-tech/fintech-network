data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  prefix     = "${var.project}-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  azs        = slice(data.aws_availability_zones.available.names, 0, 2)

  vpc_cidr = "10.20.0.0/16"

  # Each front end gets its own host name. They can't share one: the
  # session is a SameSite=Strict cookie, so every app must be the same
  # origin as the /api it calls (docs/architecture/README.md).
  web_hostnames = {
    web-consumer = "app.${var.domain_name}"
    web-merchant = "till.${var.domain_name}"
    web-admin    = "admin.${var.domain_name}"
  }

  # The admin app only exists if someone is allowed to reach it. With no
  # allowed addresses it isn't deployed at all, rather than deployed and
  # unreachable.
  hosts = {
    for app in var.web_apps : app => local.web_hostnames[app]
    if app != "web-admin" || length(var.admin_allowed_cidrs) > 0
  }
  host_list = sort(values(local.hosts))

  admin_enabled = contains(keys(local.hosts), "web-admin")

  # Listener rule order for the front ends. Fixed per app so adding or
  # removing one never renumbers the others.
  web_rule_priority = {
    web-consumer = 100
    web-merchant = 110
    web-admin    = 120
  }

  # Always https. The one exception is the incident drill, which breaks
  # this on purpose: the API refuses to start in production with a
  # plain-http origin, and no test can catch that, because it is
  # configuration rather than code.
  origin_scheme = var.incident_drill_break_api ? "http" : "https"

  images = toset(concat(["api"], keys(local.hosts)))
}

data "aws_ecr_repository" "this" {
  for_each = local.images
  name     = "${var.project}/${each.key}"
}
