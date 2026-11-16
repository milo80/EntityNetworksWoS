#!/usr/bin/env bash
# Run Terraform for one environment, from a pinned container image (nothing to
# install). AWS credentials come from your shell's environment variables.
#
#   ./tf.sh qa init
#   ./tf.sh qa plan
#   ./tf.sh qa apply
set -euo pipefail

TERRAFORM_IMAGE=docker.io/hashicorp/terraform:1.9.8

env="${1:-}"
if [[ "$env" != "qa" && "$env" != "prod" ]]; then
    echo "usage: $0 qa|prod <terraform command> [args...]" >&2
    exit 2
fi
shift

cd "$(dirname "$0")"
exec podman run --rm -it \
    -v "$PWD":/infra:Z -w "/infra/envs/$env" \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
    "$TERRAFORM_IMAGE" "$@"
