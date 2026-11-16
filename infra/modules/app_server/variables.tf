variable "name" {
  description = "Name for every resource of this environment, e.g. entitynetworks-qa."
  type        = string
}

variable "instance_type" {
  description = "EC2 size. The stack needs about 2 GB RAM (t3.small)."
  type        = string
  default     = "t3.small"
}

variable "root_volume_gb" {
  description = "Disk size. Holds the OS, images, the database and uploaded files."
  type        = number
  default     = 30
}

variable "ssh_public_key" {
  description = "Public key (the contents of a .pub file) allowed to log in as 'ubuntu'."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "Addresses allowed to reach SSH (port 22), e.g. [\"203.0.113.7/32\"]."
  type        = list(string)

  validation {
    condition     = length(var.ssh_allowed_cidrs) > 0 && !contains(var.ssh_allowed_cidrs, "0.0.0.0/0")
    error_message = "List at least one address, and not 0.0.0.0/0 (SSH open to the whole internet)."
  }
}

variable "termination_protection" {
  description = "true: AWS refuses to terminate the server until this is set back to false."
  type        = bool
  default     = false
}
