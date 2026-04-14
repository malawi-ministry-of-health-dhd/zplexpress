#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP_DIR/.env"
ENV_EXAMPLE="$APP_DIR/.env.example"

log() {
  printf "[setup] %s\n" "$1"
}

warn() {
  printf "[setup][warn] %s\n" "$1"
}

fail() {
  printf "[setup][error] %s\n" "$1" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Missing required command: $cmd"
  fi
}

read_env() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | head -n 1 | cut -d'=' -f2-
}

upsert_env() {
  local key="$1"
  local value="$2"
  local tmp_file
  tmp_file="$(mktemp)"

  if [[ -f "$ENV_FILE" ]] && grep -q -E "^${key}=" "$ENV_FILE"; then
    awk -F= -v k="$key" -v v="$value" '
      BEGIN { OFS="=" }
      $1 == k { print k, v; next }
      { print $0 }
    ' "$ENV_FILE" > "$tmp_file"
  else
    if [[ -f "$ENV_FILE" ]]; then
      cat "$ENV_FILE" > "$tmp_file"
    fi
    printf "%s=%s\n" "$key" "$value" >> "$tmp_file"
  fi

  mv "$tmp_file" "$ENV_FILE"
}

check_node_version() {
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "$major" -lt 18 ]]; then
    fail "Node.js 18+ is required. Found $(node -v)"
  fi
}

pick_default_printer() {
  local current detected printer
  current="$(read_env PRINTER_NAME || true)"
  detected=""

  if command -v lpstat >/dev/null 2>&1; then
    while IFS= read -r printer; do
      if [[ "$printer" =~ [Zz][Ee][Bb][Rr][Aa] ]]; then
        detected="$printer"
        break
      fi
      if [[ -z "$detected" ]]; then
        detected="$printer"
      fi
    done < <(lpstat -p 2>/dev/null | awk '/^printer / {print $2}')
  fi

  if [[ -n "$current" && "$current" != "name" && "$current" != "your_printer_name" ]]; then
    printf "%s" "$current"
    return 0
  fi

  if [[ -n "$detected" ]]; then
    printf "%s" "$detected"
    return 0
  fi

  printf ""
}

main() {
  cd "$APP_DIR"
  log "Starting ZPL service setup in $APP_DIR"

  require_cmd node
  require_cmd npm
  check_node_version

  log "Installing dependencies"
  if [[ -f "$APP_DIR/package-lock.json" ]]; then
    npm ci
  else
    npm install
  fi

  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ ! -f "$ENV_EXAMPLE" ]]; then
      fail "Missing .env.example"
    fi
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    log "Created .env from .env.example"
  fi

  local default_printer printer_input printer_name default_port port_input port
  default_printer="$(pick_default_printer)"
  default_port="$(read_env PORT || true)"
  default_port="${default_port:-3000}"

  printf "Printer name [%s]: " "${default_printer:-leave blank}"
  read -r printer_input
  printer_name="${printer_input:-$default_printer}"
  if [[ -n "$printer_name" ]]; then
    upsert_env "PRINTER_NAME" "$printer_name"
  else
    warn "PRINTER_NAME is empty. Printing requests will fail until a printer is set."
  fi

  printf "Port [%s]: " "$default_port"
  read -r port_input
  port="${port_input:-$default_port}"
  if ! [[ "$port" =~ ^[0-9]+$ ]] || [[ "$port" -lt 1 ]] || [[ "$port" -gt 65535 ]]; then
    fail "PORT must be an integer between 1 and 65535"
  fi
  upsert_env "PORT" "$port"

  log "Running preflight checks"
  bash "$APP_DIR/scripts/doctor.sh"

  if [[ "$(uname -s)" == "Linux" ]] && command -v systemctl >/dev/null 2>&1; then
    local install_service
    printf "Install as systemd service now? [y/N]: "
    read -r install_service
    if [[ "$install_service" =~ ^[Yy]$ ]]; then
      bash "$APP_DIR/scripts/install-service.sh"
    fi
  fi

  log "Setup complete."
  log "Start the app with: npm start"
}

main "$@"
