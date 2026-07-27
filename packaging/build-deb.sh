#!/usr/bin/env bash
#
# Build the zplexpress .deb package (Architecture: all, node_modules bundled).
#
# Usage:  packaging/build-deb.sh [version]
#   version defaults to the "version" field in package.json.
#
# Requires: dpkg-deb, node, npm  (runs in CI on Ubuntu; see release workflow).
# Output:   dist/zplexpress_<version>_all.deb
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./package.json').version")}"
PKG="zplexpress"
STAGE="$(mktemp -d)"
OUT_DIR="${ROOT}/dist"
APP_DIR="${STAGE}/opt/${PKG}"

trap 'rm -rf "$STAGE"' EXIT

echo "Building ${PKG} ${VERSION}"

# --- Application files -------------------------------------------------------
mkdir -p "$APP_DIR"
cp main.js config.js printers.js setup.js zpl-to-pdf.js dashboard.html \
   package.json package-lock.json "$APP_DIR/"

# Bundle production dependencies (no dev deps, no native modules remain).
( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund )

# --- CLI wrapper + GUI launchers -------------------------------------------
mkdir -p "${STAGE}/usr/bin"
cp packaging/zplexpress "${STAGE}/usr/bin/zplexpress"
cp packaging/zplexpress-open "${STAGE}/usr/bin/zplexpress-open"
cp packaging/zplexpress-firstrun "${STAGE}/usr/bin/zplexpress-firstrun"
chmod 0755 "${STAGE}/usr/bin/zplexpress" \
  "${STAGE}/usr/bin/zplexpress-open" "${STAGE}/usr/bin/zplexpress-firstrun"

# Desktop entry + icon (so it appears in the Applications menu).
mkdir -p "${STAGE}/usr/share/applications"
cp packaging/zplexpress.desktop "${STAGE}/usr/share/applications/zplexpress.desktop"
mkdir -p "${STAGE}/usr/share/icons/hicolor/scalable/apps"
cp packaging/zplexpress.svg "${STAGE}/usr/share/icons/hicolor/scalable/apps/zplexpress.svg"

# Autostart hook: opens the setup page on login until a printer is configured.
mkdir -p "${STAGE}/etc/xdg/autostart"
cp packaging/zplexpress-firstrun.desktop "${STAGE}/etc/xdg/autostart/zplexpress-firstrun.desktop"

# --- systemd unit -----------------------------------------------------------
mkdir -p "${STAGE}/lib/systemd/system"
cp packaging/zpl.service "${STAGE}/lib/systemd/system/zpl.service"

# --- Debian control + maintainer scripts ------------------------------------
mkdir -p "${STAGE}/DEBIAN"
sed "s/__VERSION__/${VERSION}/" packaging/debian/control > "${STAGE}/DEBIAN/control"
for script in postinst prerm postrm; do
  cp "packaging/debian/${script}" "${STAGE}/DEBIAN/${script}"
  chmod 0755 "${STAGE}/DEBIAN/${script}"
done

# --- Build ------------------------------------------------------------------
mkdir -p "$OUT_DIR"
DEB="${OUT_DIR}/${PKG}_${VERSION}_all.deb"
dpkg-deb --build --root-owner-group "$STAGE" "$DEB"

echo "Built: ${DEB}"
dpkg-deb --info "$DEB"
