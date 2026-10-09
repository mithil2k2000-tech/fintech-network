# Threat detection. GuardDuty reads the account's own activity — API
# calls, network flows, DNS lookups — and reports things like credentials
# used from somewhere unexpected or a container talking to a known
# command-and-control address. There is nothing to install.
#
# A finding nobody sees is not detection, so anything medium severity or
# worse is sent to the same place as the alarms.

resource "aws_guardduty_detector" "main" {
  count = var.enable_guardduty ? 1 : 0

  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
}

resource "aws_cloudwatch_event_rule" "guardduty_findings" {
  count = var.enable_guardduty ? 1 : 0

  name        = "${local.prefix}-guardduty-findings"
  description = "GuardDuty findings of medium severity or higher"

  event_pattern = jsonencode({
    source      = ["aws.guardduty"]
    detail-type = ["GuardDuty Finding"]
    detail      = { severity = [{ numeric = [">=", 4] }] }
  })

  depends_on = [aws_guardduty_detector.main]
}

resource "aws_cloudwatch_event_target" "guardduty_findings" {
  count = var.enable_guardduty ? 1 : 0

  rule = aws_cloudwatch_event_rule.guardduty_findings[0].name
  arn  = aws_sns_topic.alerts.arn

  # Only fields with a fixed shape go into the message: free text from
  # a finding could contain characters that break the template, and a
  # dropped alert is worse than a terse one.
  input_transformer {
    input_paths = {
      severity = "$.detail.severity"
      type     = "$.detail.type"
      region   = "$.region"
    }
    input_template = "\"GuardDuty finding in <region>: <type> (severity <severity>). Open GuardDuty in the AWS console for the detail.\""
  }
}
