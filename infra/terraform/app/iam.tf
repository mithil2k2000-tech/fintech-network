# Two kinds of role, and the difference matters:
#
#   execution role — used by ECS itself, before the container starts, to
#                    pull the image, fetch the secrets and open the log
#                    stream.
#   task role      — what the code inside the container can do in AWS.
#
# The app calls no AWS services, so its task roles have no permissions
# at all. A compromised container can talk to its database and nothing
# else in the account.

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Only tasks in this account may assume the role (confused-deputy
    # protection).
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${local.prefix}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

# Written out rather than attaching AWS's managed policy, which would
# allow pulling any image and writing to any log group in the account.
data "aws_iam_policy_document" "ecs_execution" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # this action has no resource to scope to
  }

  statement {
    sid = "PullOurImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [for repo in data.aws_ecr_repository.this : repo.arn]
  }

  statement {
    sid = "WriteOurLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = concat(
      ["${aws_cloudwatch_log_group.api.arn}:*"],
      [for group in aws_cloudwatch_log_group.web : "${group.arn}:*"],
    )
  }

  statement {
    sid     = "ReadOurSecrets"
    actions = ["ssm:GetParameters"]
    resources = [
      aws_ssm_parameter.database_url.arn,
      aws_ssm_parameter.jwt_secret.arn,
    ]
  }
}

resource "aws_iam_role_policy" "ecs_execution" {
  name   = "execution"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecs_execution.json
}

resource "aws_iam_role" "api_task" {
  name               = "${local.prefix}-api-task"
  description        = "Identity of the API container. Deliberately has no permissions."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role" "web_task" {
  name               = "${local.prefix}-web-task"
  description        = "Identity of the front-end containers. Deliberately has no permissions."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}
