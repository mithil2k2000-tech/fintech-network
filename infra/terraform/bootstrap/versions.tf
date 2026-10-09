terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # This stack keeps its state on your machine on purpose: it creates the
  # bucket every other stack stores its state in, so it can't use it yet.
  # It holds no secrets. docs/deployment/aws.md says how to move it into
  # the bucket afterwards if you want it backed up.
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Stack     = "bootstrap"
    }
  }
}
