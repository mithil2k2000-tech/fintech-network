# Two availability zones, two tiers.
#
#   public  — the load balancer and the containers
#   private — the database, with no route to or from the internet at all
#
# The containers sit in public subnets with public IPs, which is the one
# deliberate compromise here. The textbook layout puts them in private
# subnets behind a NAT gateway, and a NAT gateway costs more per month
# than everything else in this file put together. So instead: they have
# public addresses, and security groups that accept traffic from the
# load balancer and nothing else. Nothing on the internet can open a
# connection to them. docs/deployment/aws.md covers what to change to
# make them private.

resource "aws_vpc" "main" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.prefix }
}

# The default security group allows everything inside the VPC to talk to
# everything else. Adopting it with no rules turns it into one that
# allows nothing, so a resource created without an explicit group is
# isolated rather than wide open.
resource "aws_default_security_group" "locked" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${local.prefix}-default-unused" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = local.prefix }
}

resource "aws_subnet" "public" {
  count = length(local.azs)

  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(local.vpc_cidr, 8, count.index)

  # Off: a public address is something a resource asks for (the ECS
  # services do), never something it gets by landing in the subnet.
  map_public_ip_on_launch = false

  tags = { Name = "${local.prefix}-public-${local.azs[count.index]}", Tier = "public" }
}

resource "aws_subnet" "private" {
  count = length(local.azs)

  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(local.vpc_cidr, 8, count.index + 10)

  tags = { Name = "${local.prefix}-private-${local.azs[count.index]}", Tier = "private" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.prefix}-public" }
}

resource "aws_route_table_association" "public" {
  count = length(local.azs)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# No routes beyond the VPC itself. The database can be reached from
# inside and can reach nothing outside.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${local.prefix}-private" }
}

resource "aws_route_table_association" "private" {
  count = length(local.azs)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
