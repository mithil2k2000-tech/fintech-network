# One repository per image. These live in the bootstrap stack rather
# than the app stack so that tearing the app down to save money doesn't
# throw away the images: bringing it back is one `terraform apply`, not
# a rebuild.

resource "aws_ecr_repository" "this" {
  for_each = var.images

  name = "${var.project}/${each.key}"

  # Mutable because the pipeline also moves a `latest` tag. Every deploy
  # still pins the commit SHA tag, so what is running is always known.
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

# Storage is the only thing ECR charges for, so don't keep everything.
resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Remove untagged images after a day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the ten most recent images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}
