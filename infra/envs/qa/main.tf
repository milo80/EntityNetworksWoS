# QA environment. Same module as prod; only the values below differ.
# State lives in this directory (terraform.tfstate, git-ignored), separate from
# prod's, so working on QA can never change PROD.

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
      Environment = "qa"
      ManagedBy   = "terraform"
    }
  }
}

module "server" {
  source = "../../modules/app_server"

  name                   = "entitynetworks-qa"
  instance_type          = "t3.small"
  root_volume_gb         = 30
  termination_protection = false

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
