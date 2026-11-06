# CloudFront mode (no domain): one distribution per front end, each with its
# own https://<id>.cloudfront.net address and CloudFront's certificate.
# Every app is still the same origin as the /api it calls, so the
# SameSite=Strict session cookie keeps working.
#
# The load balancer only accepts HTTP from CloudFront's origin-facing
# addresses (security_groups.tf), and only forwards requests carrying a
# secret header that CloudFront adds, so it can't be used directly.

data "aws_ec2_managed_prefix_list" "cloudfront" {
  count = local.use_cloudfront ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "random_password" "origin_verify" {
  count   = local.use_cloudfront ? 1 : 0
  length  = 40
  special = false
}

data "aws_cloudfront_cache_policy" "disabled" {
  count = local.use_cloudfront ? 1 : 0
  name  = "Managed-CachingDisabled"
}

# Forwards the viewer's Host (the cloudfront.net name the load balancer
# routes on), cookies, query strings and headers.
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  count = local.use_cloudfront ? 1 : 0
  name  = "Managed-AllViewer"
}

resource "aws_cloudfront_distribution" "app" {
  for_each = local.use_cloudfront ? local.app_keys : toset([])

  enabled         = true
  is_ipv6_enabled = true
  comment         = "${local.prefix} ${each.key}"
  price_class     = "PriceClass_100"
  http_version    = "http2and3"

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.main.dns_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 30
    }

    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify[0].result
    }
  }

  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled[0].id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
