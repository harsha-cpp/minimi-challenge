#!/usr/bin/env bash
set -euo pipefail
: "${AZURE_SUBSCRIPTION_ID:?Select the intended subscription explicitly}"
: "${SSH_PUBLIC_KEY_FILE:?Path to an SSH public key}"
: "${AZURE_IMAGE_VERSION:?Exact Ubuntu image version}"
: "${ADMIN_CIDR:?Admin public IP with /32 or restricted CIDR}"
[[ "$ADMIN_CIDR" != '0.0.0.0/0' && "$ADMIN_CIDR" != '*' ]] || { echo 'Restrict SSH to your admin IP.' >&2; exit 1; }
cd "$(dirname "$0")/../.."
az bicep build --file deploy/azure/main.bicep --stdout >/dev/null
az vm list-skus --subscription "$AZURE_SUBSCRIPTION_ID" --location centralindia --resource-type virtualMachines --size Standard_B2als_v2 --all -o json
# The resource group must already exist. This script creates no resources.
az deployment group what-if --subscription "$AZURE_SUBSCRIPTION_ID" --resource-group minimi-challenge \
  --template-file deploy/azure/main.bicep --parameters "sshPublicKey=$(cat "$SSH_PUBLIC_KEY_FILE")" "adminCidr=$ADMIN_CIDR" "imageVersion=$AZURE_IMAGE_VERSION"
