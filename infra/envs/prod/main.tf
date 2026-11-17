# PROD environment. Same module as QA; only the values below differ.
# State lives in this directory (terraform.tfstate, git-ignored), separate from
# QA's. Apply here only after the same change has passed on QA.

terraform {
  required_version = "1.9.8"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "5.80.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "entitynetworks"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

module "server" {
  source = "../../modules/app_server"

  name                   = "entitynetworks-prod"
  instance_type          = "t3.small"
  root_volume_gb         = 30
  termination_protection = true # the database lives on this server
  offsite_backups        = true # daily backups also go to S3 (see infra/README.md)

  ssh_public_key    = var.ssh_public_key
  ssh_allowed_cidrs = var.ssh_allowed_cidrs
}

# Personal values: set them in terraform.tfvars (see terraform.tfvars.example).
variable "region" {
  type = string
}

variable "ssh_public_key" {
  type = string
}

variable "ssh_allowed_cidrs" {
  type = list(string)
}

output "public_ip" {
  value = module.server.public_ip
}

output "ssh" {
  value = module.server.ssh
}

output "backup_bucket" {
  value = module.server.backup_bucket
}
