# What is watched, and who is told.
#
# Every alarm here answers a question someone would otherwise ask after
# the fact: are users getting errors, is it slow, is anything healthy
# enough to serve them, and is the database about to run out of
# something. Each one emails when it fires and again when it clears.

resource "aws_sns_topic" "alerts" {
  name = "${local.prefix}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid       = "AlarmsMayPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }

  statement {
    sid       = "OurEventRulesMayPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:events:${var.aws_region}:${local.account_id}:rule/${local.prefix}-*"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}

locals {
  alarm_actions = [aws_sns_topic.alerts.arn]

  alb_dimension     = aws_lb.main.arn_suffix
  api_tg_dimension  = aws_lb_target_group.api.arn_suffix
  api_service_dims  = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.api.name }
  db_dims           = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  app_metrics_space = "${local.prefix}/App"
}

# ---- Are users getting errors? ----------------------------------------

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name        = "${local.prefix}-api-5xx"
  alarm_description = "The API returned 5 or more server errors in 5 minutes. Check the API logs for level 50 lines and the request id."

  namespace   = "AWS/ApplicationELB"
  metric_name = "HTTPCode_Target_5XX_Count"
  dimensions  = { LoadBalancer = local.alb_dimension, TargetGroup = local.api_tg_dimension }
  statistic   = "Sum"
  period      = 300

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 5
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching" # no requests is not an outage

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name        = "${local.prefix}-alb-5xx"
  alarm_description = "The load balancer itself returned 5 or more 5xx in 5 minutes: it had no healthy target to send requests to, or a target hung up."

  namespace   = "AWS/ApplicationELB"
  metric_name = "HTTPCode_ELB_5XX_Count"
  dimensions  = { LoadBalancer = local.alb_dimension }
  statistic   = "Sum"
  period      = 300

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 5
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# ---- Is anything able to serve them? ----------------------------------

resource "aws_cloudwatch_metric_alarm" "api_unhealthy" {
  alarm_name        = "${local.prefix}-api-unhealthy-targets"
  alarm_description = "An API task has been failing its readiness check (/health/ready) for 3 minutes. Usually: it can't reach the database."

  namespace   = "AWS/ApplicationELB"
  metric_name = "UnHealthyHostCount"
  dimensions  = { LoadBalancer = local.alb_dimension, TargetGroup = local.api_tg_dimension }
  statistic   = "Maximum"
  period      = 60

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 3
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_no_healthy" {
  alarm_name        = "${local.prefix}-api-no-healthy-targets"
  alarm_description = "No healthy API task for 2 minutes. The app is down."

  namespace   = "AWS/ApplicationELB"
  metric_name = "HealthyHostCount"
  dimensions  = { LoadBalancer = local.alb_dimension, TargetGroup = local.api_tg_dimension }
  statistic   = "Minimum"
  period      = 60

  comparison_operator = "LessThanThreshold"
  threshold           = 1
  evaluation_periods  = 2
  treat_missing_data  = "breaching" # no data here means no targets at all

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# ---- Is it slow? ------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "api_latency" {
  alarm_name        = "${local.prefix}-api-latency-p95"
  alarm_description = "95% of API requests have taken over a second for 3 of the last 5 minutes."

  namespace          = "AWS/ApplicationELB"
  metric_name        = "TargetResponseTime"
  dimensions         = { LoadBalancer = local.alb_dimension, TargetGroup = local.api_tg_dimension }
  extended_statistic = "p95"
  period             = 60

  comparison_operator = "GreaterThanThreshold"
  threshold           = 1
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# ---- Is the API running out of room? ----------------------------------

resource "aws_cloudwatch_metric_alarm" "api_cpu" {
  alarm_name        = "${local.prefix}-api-cpu-high"
  alarm_description = "API CPU above 85% for 10 minutes. Autoscaling adds tasks at 60%, so this means it has reached its ceiling."

  namespace   = "AWS/ECS"
  metric_name = "CPUUtilization"
  dimensions  = local.api_service_dims
  statistic   = "Average"
  period      = 300

  comparison_operator = "GreaterThanThreshold"
  threshold           = 85
  evaluation_periods  = 2

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "api_memory" {
  alarm_name        = "${local.prefix}-api-memory-high"
  alarm_description = "API memory above 85% for 10 minutes. At 100% the task is killed."

  namespace   = "AWS/ECS"
  metric_name = "MemoryUtilization"
  dimensions  = local.api_service_dims
  statistic   = "Average"
  period      = 300

  comparison_operator = "GreaterThanThreshold"
  threshold           = 85
  evaluation_periods  = 2

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# ---- Is the database about to run out of something? -------------------

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name        = "${local.prefix}-db-cpu-high"
  alarm_description = "Database CPU above 80% for 10 minutes."

  namespace   = "AWS/RDS"
  metric_name = "CPUUtilization"
  dimensions  = local.db_dims
  statistic   = "Average"
  period      = 300

  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  evaluation_periods  = 2

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name        = "${local.prefix}-db-storage-low"
  alarm_description = "Less than 2 GB of database storage left. The ledger is append-only and only grows."

  namespace   = "AWS/RDS"
  metric_name = "FreeStorageSpace"
  dimensions  = local.db_dims
  statistic   = "Minimum"
  period      = 300

  comparison_operator = "LessThanThreshold"
  threshold           = 2 * 1024 * 1024 * 1024
  evaluation_periods  = 1

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "db_connections" {
  alarm_name        = "${local.prefix}-db-connections-high"
  alarm_description = "Database connections above 70. A db.t4g.micro allows roughly 100; each API task holds a pool, so this is what scaling out too far looks like."

  namespace   = "AWS/RDS"
  metric_name = "DatabaseConnections"
  dimensions  = local.db_dims
  statistic   = "Maximum"
  period      = 300

  comparison_operator = "GreaterThanThreshold"
  threshold           = 70
  evaluation_periods  = 2

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# ---- What is the app itself saying? -----------------------------------
# The API logs one JSON line per event (pino). Level 50 is "error" and 60
# is "fatal". Counting those turns the logs into a metric, which catches
# failures that never become a 5xx.

resource "aws_cloudwatch_log_metric_filter" "api_errors" {
  name           = "${local.prefix}-api-error-logs"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.level >= 50 }"

  metric_transformation {
    namespace     = local.app_metrics_space
    name          = "ApiErrorLogs"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_error_logs" {
  alarm_name        = "${local.prefix}-api-error-logs"
  alarm_description = "The API logged 5 or more errors in 5 minutes."

  namespace   = local.app_metrics_space
  metric_name = aws_cloudwatch_log_metric_filter.api_errors.metric_transformation[0].name
  statistic   = "Sum"
  period      = 300

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 5
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
}

# ---- Failed deployments -----------------------------------------------
# When the circuit breaker gives up on a release and rolls it back, say
# so. A rollback that works silently is a broken release nobody knows
# about.

resource "aws_cloudwatch_event_rule" "deployment_failed" {
  name        = "${local.prefix}-ecs-deployment-failed"
  description = "An ECS deployment in this cluster failed and was rolled back"

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Deployment State Change"]
    resources   = [{ prefix = "arn:aws:ecs:${var.aws_region}:${local.account_id}:service/${local.prefix}/" }]
    detail      = { eventName = ["SERVICE_DEPLOYMENT_FAILED"] }
  })
}

resource "aws_cloudwatch_event_target" "deployment_failed" {
  rule = aws_cloudwatch_event_rule.deployment_failed.name
  arn  = aws_sns_topic.alerts.arn

  input_transformer {
    input_paths = {
      service = "$.resources[0]"
      reason  = "$.detail.reason"
      time    = "$.time"
    }
    input_template = "\"Deployment FAILED and was rolled back.\\nService: <service>\\nWhen: <time>\\nReason: <reason>\""
  }
}

# ---- The dashboard ----------------------------------------------------
# One screen, top to bottom in the order you'd ask during an incident:
# what are users seeing, is the API coping, is the database coping.

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = local.prefix

  dashboard_body = jsonencode({
    widgets = [
      {
        type       = "text", x = 0, y = 0, width = 24, height = 1
        properties = { markdown = "## What users see — requests, errors and latency at the load balancer" }
      },
      {
        type = "metric", x = 0, y = 1, width = 8, height = 6
        properties = {
          title  = "Requests per minute"
          region = var.aws_region
          stat   = "Sum"
          period = 60
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", local.alb_dimension, { label = "All requests" }],
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", local.alb_dimension, "TargetGroup", local.api_tg_dimension, { label = "API" }],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 1, width = 8, height = 6
        properties = {
          title  = "Errors per minute"
          region = var.aws_region
          stat   = "Sum"
          period = 60
          metrics = [
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", local.alb_dimension, "TargetGroup", local.api_tg_dimension, { label = "API 5xx" }],
            ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", local.alb_dimension, { label = "Load balancer 5xx" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_4XX_Count", "LoadBalancer", local.alb_dimension, "TargetGroup", local.api_tg_dimension, { label = "API 4xx" }],
            [local.app_metrics_space, "ApiErrorLogs", { label = "Error log lines" }],
          ]
        }
      },
      {
        type = "metric", x = 16, y = 1, width = 8, height = 6
        properties = {
          title  = "API response time (seconds)"
          region = var.aws_region
          period = 60
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", local.alb_dimension, "TargetGroup", local.api_tg_dimension, { stat = "p50", label = "p50" }],
            ["...", { stat = "p95", label = "p95" }],
            ["...", { stat = "p99", label = "p99" }],
          ]
          annotations = { horizontal = [{ label = "Alarm", value = 1 }] }
        }
      },
      {
        type       = "text", x = 0, y = 7, width = 24, height = 1
        properties = { markdown = "## Is the API coping — healthy tasks, CPU and memory" }
      },
      {
        type = "metric", x = 0, y = 8, width = 8, height = 6
        properties = {
          title  = "API tasks behind the load balancer"
          region = var.aws_region
          period = 60
          metrics = [
            ["AWS/ApplicationELB", "HealthyHostCount", "LoadBalancer", local.alb_dimension, "TargetGroup", local.api_tg_dimension, { stat = "Minimum", label = "Healthy" }],
            ["AWS/ApplicationELB", "UnHealthyHostCount", "LoadBalancer", local.alb_dimension, "TargetGroup", local.api_tg_dimension, { stat = "Maximum", label = "Unhealthy" }],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 8, width = 8, height = 6
        properties = {
          title  = "API CPU and memory (%)"
          region = var.aws_region
          stat   = "Average"
          period = 60
          yAxis  = { left = { min = 0, max = 100 } }
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.api.name, { label = "CPU" }],
            ["AWS/ECS", "MemoryUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.api.name, { label = "Memory" }],
          ]
        }
      },
      {
        type = "alarm", x = 16, y = 8, width = 8, height = 6
        properties = {
          title = "Alarms"
          alarms = [
            aws_cloudwatch_metric_alarm.api_no_healthy.arn,
            aws_cloudwatch_metric_alarm.api_unhealthy.arn,
            aws_cloudwatch_metric_alarm.api_5xx.arn,
            aws_cloudwatch_metric_alarm.alb_5xx.arn,
            aws_cloudwatch_metric_alarm.api_latency.arn,
            aws_cloudwatch_metric_alarm.api_error_logs.arn,
            aws_cloudwatch_metric_alarm.api_cpu.arn,
            aws_cloudwatch_metric_alarm.api_memory.arn,
            aws_cloudwatch_metric_alarm.db_cpu.arn,
            aws_cloudwatch_metric_alarm.db_connections.arn,
            aws_cloudwatch_metric_alarm.db_storage.arn,
          ]
        }
      },
      {
        type       = "text", x = 0, y = 14, width = 24, height = 1
        properties = { markdown = "## Is the database coping — CPU, connections and storage" }
      },
      {
        type = "metric", x = 0, y = 15, width = 8, height = 6
        properties = {
          title  = "Database CPU (%)"
          region = var.aws_region
          stat   = "Average"
          period = 60
          yAxis  = { left = { min = 0, max = 100 } }
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.main.identifier, { label = "CPU" }],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 15, width = 8, height = 6
        properties = {
          title  = "Database connections"
          region = var.aws_region
          stat   = "Maximum"
          period = 60
          metrics = [
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", aws_db_instance.main.identifier, { label = "Connections" }],
          ]
          annotations = { horizontal = [{ label = "Alarm", value = 70 }] }
        }
      },
      {
        type = "metric", x = 16, y = 15, width = 8, height = 6
        properties = {
          title  = "Database free storage (bytes)"
          region = var.aws_region
          stat   = "Minimum"
          period = 300
          metrics = [
            ["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", aws_db_instance.main.identifier, { label = "Free storage" }],
          ]
        }
      },
      {
        type = "log", x = 0, y = 21, width = 24, height = 7
        properties = {
          title  = "Latest API errors"
          region = var.aws_region
          view   = "table"
          query  = "SOURCE '${aws_cloudwatch_log_group.api.name}' | fields @timestamp, reqId, msg, err.message | filter level >= 50 | sort @timestamp desc | limit 25"
        }
      },
    ]
  })
}
