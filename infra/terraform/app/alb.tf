# The front door. TLS ends here, and this is where a request is sent to
# the API or to one of the front ends.

resource "aws_lb" "main" {
  name               = local.prefix
  load_balancer_type = "application"
  internal           = false
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]

  # Malformed headers are dropped rather than passed on for the app to
  # interpret: request smuggling depends on two parsers disagreeing.
  drop_invalid_header_fields = true
  idle_timeout               = 60
}

resource "aws_lb_target_group" "api" {
  name        = "${local.prefix}-api"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  protocol    = "HTTP"
  port        = 3000

  # How long a task being replaced keeps finishing requests it already
  # has. The default is five minutes, which is five minutes per deploy.
  deregistration_delay = 30

  health_check {
    # Readiness, not liveness: this asks the API whether it can reach
    # its database, because a task that can't shouldn't get traffic
    # (docs/deployment/README.md explains the split).
    path                = "/health/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_target_group" "web" {
  for_each = local.hosts

  # Target group names stop at 32 characters, hence "consumer" rather
  # than "web-consumer".
  name        = "${local.prefix}-${trimprefix(each.key, "web-")}"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  protocol    = "HTTP"
  port        = 80

  deregistration_delay = 15

  health_check {
    path                = "/"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  protocol          = "HTTP"
  port              = 80

  # Own domain: redirect to HTTPS. CloudFront mode: this is the listener
  # CloudFront talks to, and anything that doesn't match a rule gets a 404.
  default_action {
    type = local.use_cloudfront ? "fixed-response" : "redirect"

    dynamic "redirect" {
      for_each = local.use_cloudfront ? [] : [1]
      content {
        protocol    = "HTTPS"
        port        = "443"
        status_code = "HTTP_301"
      }
    }

    dynamic "fixed_response" {
      for_each = local.use_cloudfront ? [1] : []
      content {
        content_type = "text/plain"
        message_body = "Not found"
        status_code  = "404"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count = local.use_cloudfront ? 0 : 1

  load_balancer_arn = aws_lb.main.arn
  protocol          = "HTTPS"
  port              = 443
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main[0].certificate_arn

  # Anything that isn't one of our host names — a scanner hitting the
  # raw address, mostly — gets nothing useful.
  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

# ---- Routing ----------------------------------------------------------
# Rules are tried in priority order; the first match wins.

# The admin API is only for the allowed addresses...
resource "aws_lb_listener_rule" "admin_api_allowed" {
  count = local.admin_enabled ? 1 : 0

  listener_arn = local.listener_arn
  priority     = 10

  condition {
    path_pattern {
      values = ["/api/v1/admin/*"]
    }
  }

  condition {
    source_ip {
      values = var.admin_allowed_cidrs
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# ...and refused here for everyone else, before the request reaches the
# app. The API still checks the role itself; this is a second lock on
# the same door, not a replacement for the first.
resource "aws_lb_listener_rule" "admin_api_denied" {
  listener_arn = local.listener_arn
  priority     = 20

  condition {
    path_pattern {
      values = ["/api/v1/admin/*"]
    }
  }

  action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      message_body = jsonencode({ error = "FORBIDDEN" })
      status_code  = "403"
    }
  }
}

# /api on any of the app hosts goes straight to the API. Only /api:
# /health and /metrics stay unreachable from outside, which is what the
# app's own docs ask for.
resource "aws_lb_listener_rule" "api" {
  listener_arn = local.listener_arn
  priority     = 30

  condition {
    path_pattern {
      values = ["/api/*"]
    }
  }

  condition {
    host_header {
      values = local.host_list
    }
  }

  dynamic "condition" {
    for_each = local.use_cloudfront ? [1] : []
    content {
      http_header {
        http_header_name = "X-Origin-Verify"
        values           = [random_password.origin_verify[0].result]
      }
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# Everything else on a host goes to that host's front end.
resource "aws_lb_listener_rule" "web" {
  for_each = { for app in local.app_keys : app => local.hosts[app] if app != "web-admin" }

  listener_arn = local.listener_arn
  priority     = local.web_rule_priority[each.key]

  condition {
    host_header {
      values = [each.value]
    }
  }

  dynamic "condition" {
    for_each = local.use_cloudfront ? [1] : []
    content {
      http_header {
        http_header_name = "X-Origin-Verify"
        values           = [random_password.origin_verify[0].result]
      }
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web[each.key].arn
  }
}

# The admin app is routed for the allowed addresses and nobody else; an
# operations view has no business being reachable from the internet.
resource "aws_lb_listener_rule" "web_admin" {
  count = local.admin_enabled ? 1 : 0

  listener_arn = local.listener_arn
  priority     = local.web_rule_priority["web-admin"]

  condition {
    host_header {
      values = [local.hosts["web-admin"]]
    }
  }

  condition {
    source_ip {
      values = var.admin_allowed_cidrs
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web["web-admin"].arn
  }
}
