# Who may talk to whom. Each rule names a security group rather than an
# address range wherever it can, so the chain reads as it works:
#
#   internet → load balancer → API → database
#                            → front ends
#
# and there is no rule that lets anything skip a step.

resource "aws_security_group" "alb" {
  name        = "${local.prefix}-alb"
  description = "Load balancer: the only thing the internet can reach"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.prefix}-alb" }
}

resource "aws_security_group" "api" {
  name        = "${local.prefix}-api"
  description = "API tasks: reachable from the load balancer only"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.prefix}-api" }
}

resource "aws_security_group" "web" {
  name        = "${local.prefix}-web"
  description = "Front-end tasks: reachable from the load balancer only"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.prefix}-web" }
}

resource "aws_security_group" "db" {
  name        = "${local.prefix}-db"
  description = "Database: reachable from the API only"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.prefix}-db" }
}

# ---- Load balancer ----------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from anywhere"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from anywhere, only ever answered with a redirect to HTTPS"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the API"
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the front ends"
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

# ---- API --------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  description                  = "From the load balancer"
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_vpc_security_group_egress_rule" "api_to_db" {
  security_group_id            = aws_security_group.api.id
  description                  = "To the database"
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "api_https_out" {
  security_group_id = aws_security_group.api.id
  description       = "HTTPS out: pull the image, read secrets, ship logs"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# ---- Front ends -------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web.id
  description                  = "From the load balancer"
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_egress_rule" "web_https_out" {
  security_group_id = aws_security_group.web.id
  description       = "HTTPS out: pull the image, ship logs"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# ---- Database ---------------------------------------------------------
# One way in, and no egress rules at all.

resource "aws_vpc_security_group_ingress_rule" "db_from_api" {
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from the API"
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
