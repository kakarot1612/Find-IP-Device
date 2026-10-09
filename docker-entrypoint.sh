#!/bin/sh
set -eu

read_secret() {
  if [ -f "$1" ]; then
    cat "$1"
  fi
}

export CISCO_SSH_USERNAME="$(read_secret /run/secrets/ssh_username)"
export CISCO_SSH_PASSWORD="$(read_secret /run/secrets/ssh_password)"
export CISCO_SSH_PRIVATE_KEY="$(read_secret /run/secrets/ssh_private_key)"
export CISCO_SSH_KEY_PASSPHRASE="$(read_secret /run/secrets/ssh_key_passphrase)"
export CISCO_ENABLE_PASSWORD="$(read_secret /run/secrets/enable_password)"
export ADMIN_USERNAME="$(read_secret /run/secrets/admin_username)"
export ADMIN_PASSWORD="$(read_secret /run/secrets/admin_password)"

if [ -z "$CISCO_SSH_USERNAME" ]; then
  echo 'Missing Docker secret: secrets/ssh_username' >&2
  exit 1
fi

if [ -z "$CISCO_SSH_PASSWORD" ] && [ -z "$CISCO_SSH_PRIVATE_KEY" ]; then
  echo 'Set secrets/ssh_password or secrets/ssh_private_key.' >&2
  exit 1
fi

if [ -z "$ADMIN_PASSWORD" ]; then
  echo 'Warning: ADMIN_PASSWORD empty — using default "admin".' >&2
fi

exec gosu node node src/server.js