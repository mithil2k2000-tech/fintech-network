# The two secrets the API needs, generated here and handed to the
# container by ECS at start-up. They are never in the image, the
# repository or a workflow file.
#
# Parameter Store rather than Secrets Manager: SecureString parameters
# are encrypted the same way and cost nothing, where Secrets Manager
# charges per secret per month for rotation features this doesn't use.
#
# Both values are in the Terraform state, which is why the state bucket
# is private, encrypted and versioned.

resource "random_password" "db" {
  length = 32
  # Letters and digits only, so it can sit in a connection URL unescaped.
  special = false
}

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "database_url" {
  name        = "/${local.prefix}/DATABASE_URL"
  description = "PostgreSQL connection string for the API"
  type        = "SecureString"

  # verify-full: encrypt the connection AND check the server really is
  # our database. The image carries the AWS RDS certificate authority
  # (services/api/Dockerfile) so that check can pass.
  value = "postgres://${aws_db_instance.main.username}:${random_password.db.result}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/${aws_db_instance.main.db_name}?sslmode=verify-full"
}

resource "aws_ssm_parameter" "jwt_secret" {
  name        = "/${local.prefix}/JWT_SECRET"
  description = "Session signing secret. Replacing it signs everyone out."
  type        = "SecureString"
  value       = random_password.jwt.result
}
