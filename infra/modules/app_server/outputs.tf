output "public_ip" {
  description = "Point the domain's DNS A record here."
  value       = aws_eip.server.public_ip
}

output "ssh" {
  description = "Log in to the server."
  value       = "ssh ubuntu@${aws_eip.server.public_ip}"
}

output "instance_id" {
  value = aws_instance.server.id
}

output "backup_bucket" {
  description = "S3 bucket for off-server backups (null when offsite_backups is off)."
  value       = var.offsite_backups ? aws_s3_bucket.backups[0].bucket : null
}
