#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${SERVICE_NAME:-zpl.service}"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"

log() {
  printf "[service] %s\n" "$1"
}

fail() {
  printf "[service][error] %s\n" "$1" >&2
  exit 1
}

assert_linux() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    fail "systemd install is only supported on Linux."
  fi
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      log "Escalating with sudo to install system service."
      exec sudo SERVICE_NAME="$SERVICE_NAME" bash "$0" "$@"
    fi
    fail "Root privileges are required. Run with sudo."
  fi
}

main() {
  assert_linux
  require_root "$@"

  command -v systemctl >/dev/null 2>&1 || fail "systemctl is required."
  local node_bin
  node_bin="$(command -v node || true)"
  [[ -n "$node_bin" ]] || fail "node command not found."

  local run_user run_group
  run_user="${SUDO_USER:-$USER}"
  run_group="$(id -gn "$run_user")"

  log "Writing ${SERVICE_PATH}"
  cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=ZPL Printing Service
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${node_bin} main.js
Restart=always
RestartSec=2
User=${run_user}
Group=${run_group}
Environment=NODE_ENV=production
EnvironmentFile=-${APP_DIR}/.env

[Install]
WantedBy=multi-user.target
EOF

  log "Reloading systemd and enabling ${SERVICE_NAME}"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"

  log "Service installed. Current status:"
  systemctl --no-pager status "$SERVICE_NAME" || true
  log "Follow logs with: sudo journalctl -u ${SERVICE_NAME} -f"
}

main "$@"
