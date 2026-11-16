# One EC2 server that runs deploy/compose.yaml, the same stack as a local
# `podman compose up`. Uses the account's default VPC to keep the setup small.

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

data "aws_vpc" "default" {
  default = true
}

# Latest Ubuntu 24.04 LTS at creation time. Later image updates are ignored
# (see lifecycle below), so an apply never replaces a running server by surprise.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "admin" {
  key_name   = "${var.name}-admin"
  public_key = var.ssh_public_key
}

resource "aws_security_group" "server" {
  name        = var.name
  description = "EntityNetworks: web from anywhere, SSH from listed addresses"
  vpc_id      = data.aws_vpc.default.id

  # Caddy: port 80 is needed for Let's Encrypt and the redirect to HTTPS.
  ingress {
    description      = "HTTP"
    from_port        = 80
    to_port          = 80
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    description      = "HTTPS"
    from_port        = 443
    to_port          = 443
    protocol         = "tcp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    description      = "HTTP/3"
    from_port        = 443
    to_port          = 443
    protocol         = "udp"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_cidrs
  }

  egress {
    description      = "All outbound (packages, images, Let's Encrypt)"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

resource "aws_instance" "server" {
  ami                     = data.aws_ami.ubuntu.id
  instance_type           = var.instance_type
  key_name                = aws_key_pair.admin.key_name
  vpc_security_group_ids  = [aws_security_group.server.id]
  user_data               = file("${path.module}/cloud-init.yaml")
  disable_api_termination = var.termination_protection

  metadata_options {
    http_tokens = "required" # IMDSv2 only
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  tags = {
    Name = var.name
  }

  lifecycle {
    ignore_changes = [ami, user_data]
  }
}

# Fixed public address: the DNS record keeps pointing at the server across
# stops and starts.
resource "aws_eip" "server" {
  domain   = "vpc"
  instance = aws_instance.server.id

  tags = {
    Name = var.name
  }
}
