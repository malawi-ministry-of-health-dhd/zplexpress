#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
FAILURES=0

ok() {
  printf "[doctor][ok] %s\n" "$1"
}

warn() {
  printf "[doctor][warn] %s\n" "$1"
}

fail() {
  printf "[doctor][error] %s\n" "$1"
  FAILURES=$((FAILURES + 1))
}

env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | head -n 1 | cut -d'=' -f2-
}

check_command() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "Found command: $cmd"
  else
    fail "Missing command: $cmd"
  fi
}

check_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js is missing"
    return
  fi

  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "$major" -lt 18 ]]; then
    fail "Node.js 18+ required. Found $(node -v)"
  else
    ok "Node version is $(node -v)"
  fi
}

check_port_available() {
  local port="$1"
  if [[ -z "$port" ]]; then
    fail "PORT is not set in .env"
    return
  fi

  if ! [[ "$port" =~ ^[0-9]+$ ]] || [[ "$port" -lt 1 ]] || [[ "$port" -gt 65535 ]]; then
    fail "PORT must be an integer between 1 and 65535. Found: $port"
    return
  fi

  if command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      fail "PORT $port is already in use"
      return
    fi
  fi

  ok "PORT $port looks available"
}

check_printer() {
  local configured_printer printers
  configured_printer="$(env_value PRINTER_NAME || true)"

  if ! command -v lpstat >/dev/null 2>&1; then
    warn "lpstat not found; skipping printer discovery"
    if [[ -z "$configured_printer" ]]; then
      fail "PRINTER_NAME is empty and printer discovery is unavailable"
    fi
    return
  fi

  printers="$(lpstat -p 2>/dev/null | awk '/^printer / {print $2}' || true)"
  if [[ -n "$printers" ]]; then
    ok "Detected printers: $(printf "%s" "$printers" | paste -sd "," -)"
  else
    warn "No printers detected by lpstat"
  fi

  if [[ -z "$configured_printer" ]]; then
    if printf "%s\n" "$printers" | grep -qi "zebra"; then
      ok "Zebra printer auto-detect should work"
    else
      fail "Set PRINTER_NAME in .env or connect a Zebra printer"
    fi
    return
  fi

  if [[ -n "$printers" ]] && ! printf "%s\n" "$printers" | grep -Fxq "$configured_printer"; then
    warn "Configured PRINTER_NAME ($configured_printer) was not found in lpstat output"
  else
    ok "PRINTER_NAME is set to $configured_printer"
  fi
}

main() {
  printf "[doctor] Running checks in %s\n" "$APP_DIR"
  check_command npm
  check_command lp
  check_command lpstat
  check_node_version

  if [[ -f "$ENV_FILE" ]]; then
    ok "Found .env file"
  else
    fail "Missing .env file"
  fi

  check_port_available "$(env_value PORT || true)"
  check_printer

  if [[ "$FAILURES" -gt 0 ]]; then
    printf "[doctor] Failed with %d issue(s).\n" "$FAILURES"
    exit 1
  fi

  printf "[doctor] All checks passed.\n"
}

main "$@"
