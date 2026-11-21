#!/usr/bin/env bash
# Run as root on a fresh Ubuntu 24.04 VM after staging the reviewed repository.
# Deliberately does not start the service or copy live databases.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root on the target VM.' >&2; exit 1; }
: "${ASOF_VAULT:?Key Vault name}"
: "${ASOF_DOMAIN:?Public HTTPS hostname}"
: "${ASOF_STORAGE:?Private backup storage account}"
[[ "$ASOF_VAULT" =~ ^[a-zA-Z0-9-]{3,24}$ ]] || exit 1
[[ "$ASOF_DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]] || exit 1
[[ "$ASOF_STORAGE" =~ ^[a-z0-9]{3,24}$ ]] || exit 1
cd /opt/asof/app
[[ ! -e .env ]] || { echo 'Remove the staged .env; use Key Vault.' >&2; exit 1; }
version=$(tr -d '\r\n' < .nvmrc)
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
apt-get update
apt-get install -y ca-certificates curl xz-utils caddy
id asof >/dev/null 2>&1 || useradd --system --home /opt/asof --shell /usr/sbin/nologin asof
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
arch=$(uname -m)
[[ "$arch" == x86_64 ]] || { echo 'This installer targets x64.' >&2; exit 1; }
archive="node-v${version}-linux-x64.tar.xz"
curl --fail --silent --show-error --connect-timeout 10 --max-time 180 "https://nodejs.org/dist/v${version}/${archive}" -o "$tmp/$archive"
curl --fail --silent --show-error --connect-timeout 10 --max-time 30 "https://nodejs.org/dist/v${version}/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
(cd "$tmp"; awk -v f="$archive" '$2 == f' SHASUMS256.txt > selected.sha256; test -s selected.sha256; sha256sum -c selected.sha256)
tar -xJf "$tmp/$archive" -C /usr/local --strip-components=1
npm ci
npm run typecheck
mkdir -p data /etc/asof /etc/systemd/system/caddy.service.d
chown -R asof:asof data
chmod 700 data
printf 'ASOF_VAULT=%s\n' "$ASOF_VAULT" > /etc/asof/identity.conf
printf 'ASOF_STORAGE=%s\n' "$ASOF_STORAGE" >> /etc/asof/identity.conf
chmod 644 /etc/asof/identity.conf
printf '[Service]\nEnvironment=ASOF_DOMAIN=%s\n' "$ASOF_DOMAIN" > /etc/systemd/system/caddy.service.d/asof.conf
install -m 644 deploy/azure/asof.service /etc/systemd/system/asof.service
install -m 644 deploy/azure/asof-backup.service /etc/systemd/system/asof-backup.service
install -m 644 deploy/azure/asof-backup.timer /etc/systemd/system/asof-backup.timer
install -m 644 deploy/azure/Caddyfile /etc/caddy/Caddyfile
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=128M\nRuntimeMaxUse=32M\n' > /etc/systemd/journald.conf.d/asof.conf
systemctl restart systemd-journald
systemctl daemon-reload
printf '%s\n' 'Installed. Restore reconciled data and configure the Key Vault secret before starting asof.'
