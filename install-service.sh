#!/usr/bin/env bash
#
# One-command installer for the ZPL printing service (Linux systemd).
# Auto-detects the node binary and project directory, generates the
# systemd unit with correct paths, then enables and starts it.
#
# Usage:  ./install-service.sh        (re-runs itself with sudo if needed)
#
set -euo pipefail

SERVICE_NAME="zpl.service"
SYSTEMD_PATH="/etc/systemd/system/${SERVICE_NAME}"

# Require systemd.
if ! command -v systemctl >/dev/null 2>&1; then
  echo "Error: systemctl not found. This installer targets Linux systemd systems." >&2
  exit 1
fi

# Resolve config from the invoking user's environment (before any sudo re-exec).
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
RUN_USER="${RUN_USER:-${SUDO_USER:-$USER}}"

if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH." >&2
  exit 1
fi
if [ ! -f "${APP_DIR}/main.js" ]; then
  echo "Error: main.js not found in ${APP_DIR}." >&2
  exit 1
fi

RUN_GROUP="${RUN_GROUP:-$(id -gn "$RUN_USER")}"
NODE_DIR="$(dirname "$NODE_BIN")"

# Writing to /etc/systemd/system needs root — re-exec via sudo, passing the
# resolved values so detection reflects the real user, not root.
if [ "$(id -u)" -ne 0 ]; then
  echo "Root privileges required; re-running with sudo..."
  exec sudo NODE_BIN="$NODE_BIN" APP_DIR="$APP_DIR" \
    RUN_USER="$RUN_USER" RUN_GROUP="$RUN_GROUP" bash "$0" "$@"
fi

# The service runs non-interactively (no TTY), so a printer must already be
# configured — otherwise main.js tries to launch the wizard and crash-loops.
if [ ! -f "${APP_DIR}/config.json" ]; then
  echo "Warning: no config.json found in ${APP_DIR}." >&2
  echo "         Run 'node main.js setup' first to select a printer and port;" >&2
  echo "         systemd has no terminal to run the interactive wizard." >&2
fi

echo "Installing ${SERVICE_NAME}:"
echo "  node:       ${NODE_BIN}"
echo "  app dir:    ${APP_DIR}"
echo "  run as:     ${RUN_USER}:${RUN_GROUP}"

cat > "$SYSTEMD_PATH" <<EOF
[Unit]
Description=ZPL printing service
After=network.target

[Service]
ExecStart=${NODE_BIN} ${APP_DIR}/main.js
Restart=always
User=${RUN_USER}
Group=${RUN_GROUP}
Environment=PATH=${NODE_DIR}:/usr/bin:/usr/local/bin
Environment=NODE_ENV=production
WorkingDirectory=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo
echo "Done. Service status:"
systemctl --no-pager status "$SERVICE_NAME" || true
echo
echo "Follow logs with:  sudo journalctl -u ${SERVICE_NAME} -f"
