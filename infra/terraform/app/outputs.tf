output "urls" {
  description = "Where each app lives."
  value       = { for app, host in local.hosts : app => "https://${host}" }
}

output "app_url" {
  description = "Set as the GitHub repository variable APP_URL so the pipeline can smoke-test a deploy."
  value       = "https://${local.hosts["web-consumer"]}"
}

output "dashboard_url" {
  value = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards/dashboard/${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "api_log_group" {
  value = aws_cloudwatch_log_group.api.name
}

output "load_balancer_dns_name" {
  value = aws_lb.main.dns_name
}

output "database_endpoint" {
  description = "Private: only resolvable to something reachable from inside the VPC."
  value       = aws_db_instance.main.address
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
