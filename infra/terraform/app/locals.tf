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
  # No domain: each front end is served from its own CloudFront distribution
  # and *.cloudfront.net address, which gives HTTPS without owning a domain
  # (cloudfront.tf). The admin app is not offered in this mode: behind
  # CloudFront the load balancer sees CloudFront's address, not the admin's,
  # so the source-IP allow-list could not work.
  use_cloudfront = var.domain_name == ""

  app_keys = toset([
    for app in var.web_apps : app
    if app != "web-admin" || (length(var.admin_allowed_cidrs) > 0 && !local.use_cloudfront)
  ])

  hosts = {
    for app in local.app_keys : app => (
      local.use_cloudfront ? aws_cloudfront_distribution.app[app].domain_name : local.web_hostnames[app]
    )
  }
  host_list = sort(values(local.hosts))

  admin_enabled = contains(local.app_keys, "web-admin")

  # Requests reach the API through the load balancer, plus CloudFront in
  # CloudFront mode; each adds one X-Forwarded-For hop.
  proxy_hops = local.use_cloudfront ? 2 : 1

  # Rules either listen for HTTPS on the load balancer (own domain) or for
  # HTTP from CloudFront only (CloudFront mode).
  listener_arn = local.use_cloudfront ? aws_lb_listener.http.arn : aws_lb_listener.https[0].arn

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

  images = toset(concat(["api"], tolist(local.app_keys)))
}

data "aws_ecr_repository" "this" {
  for_each = local.images
  name     = "${var.project}/${each.key}"
}
