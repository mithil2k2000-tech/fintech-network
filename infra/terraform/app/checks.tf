check "domain_settings" {
  assert {
    condition     = (var.domain_name == "") == (var.route53_zone_name == "")
    error_message = "Set both domain_name and route53_zone_name, or neither (CloudFront mode)."
  }
}
