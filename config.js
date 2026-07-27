const fs = require('fs');
const path = require('path');

// Config location is overridable via ZPL_CONFIG (used by the packaged
// install, which stores config in /etc/zplexpress/config.json).
const CONFIG_PATH = process.env.ZPL_CONFIG || path.join(__dirname, 'config.json');
const RENDER_MODES = Object.freeze({
  PDF_RASTER: 'PDFRaster',
  NATIVE_TSPL: 'NativeTSPL',
});

function normalizeRenderMode(value) {
  const mode = value || RENDER_MODES.PDF_RASTER;
  if (!Object.values(RENDER_MODES).includes(mode)) {
    throw new TypeError(
      `renderMode must be ${RENDER_MODES.PDF_RASTER} or ${RENDER_MODES.NATIVE_TSPL}`,
    );
  }
  return mode;
}

// Load saved configuration, falling back to environment variables.
function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    // No config file yet — fall back to environment.
  }

  return {
    printerName: saved.printerName ?? process.env.PRINTER_NAME ?? null,
    port: saved.port ?? (process.env.PORT ? Number(process.env.PORT) : 3000),
    renderMode: normalizeRenderMode(
      saved.renderMode ?? process.env.ZPL_RENDER_MODE ?? RENDER_MODES.PDF_RASTER,
    ),
  };
}

// Persist configuration to config.json.
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

module.exports = {
  CONFIG_PATH,
  RENDER_MODES,
  loadConfig,
  normalizeRenderMode,
  saveConfig,
};
