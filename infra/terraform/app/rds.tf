# Managed PostgreSQL, in the private subnets, reachable from the API's
# security group and nothing else.

resource "aws_db_subnet_group" "main" {
  name       = local.prefix
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name_prefix = "${local.prefix}-pg16-"
  family      = "postgres16"

  # Refuse unencrypted connections. This is the default on PostgreSQL 16,
  # stated here so it is a decision rather than an accident.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Log any statement slower than half a second, so "it's slow" has
  # somewhere to start.
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "main" {
  identifier = local.prefix

  engine         = "postgres"
  engine_version = "16" # major version only: AWS applies minor patches
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_allocated_storage_gb * 2 # the ledger only grows
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "fintech_network"
  username = "fintech"
  password = random_password.db.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  backup_retention_period    = var.db_backup_retention_days
  backup_window              = "02:00-03:00"
  maintenance_window         = "sun:03:30-sun:04:30"
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true

  enabled_cloudwatch_logs_exports = ["postgresql"]

  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = var.db_skip_final_snapshot
  final_snapshot_identifier = var.db_skip_final_snapshot ? null : "${local.prefix}-final"

  apply_immediately = true

  # RDS creates the log group itself if it gets there first, and then
  # Terraform can't.
  depends_on = [aws_cloudwatch_log_group.rds]
}

# Declared here so the database's logs have a retention period; left to
# itself RDS creates the group and keeps them forever.
resource "aws_cloudwatch_log_group" "rds" {
  name              = "/aws/rds/instance/${local.prefix}/postgresql"
  retention_in_days = var.log_retention_days
}
