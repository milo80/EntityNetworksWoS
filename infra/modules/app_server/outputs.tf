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
