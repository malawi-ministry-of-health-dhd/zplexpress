const fs = require('fs');
const path = require('path');

// Config location is overridable via ZPL_CONFIG (used by the packaged
// install, which stores config in /etc/zplexpress/config.json).
const CONFIG_PATH = process.env.ZPL_CONFIG || path.join(__dirname, 'config.json');
const RENDER_MODES = Object.freeze({
  PDF_RASTER: 'PDFRaster',
  NATIVE_TSPL: 'NativeTSPL',
});
const PRINTER_MODELS = Object.freeze({
  ARGOX: 'ARGOX',
  ZEBRA: 'ZEBRA',
  OCOM: 'OCOM',
});
const PRINT_ROUTES = Object.freeze({
  RAW_ZPL: 'RawZPL',
  OCOM_PDF_RASTER: 'OCOMPDFRaster',
  OCOM_NATIVE_TSPL: 'OCOMNativeTSPL',
});

function normalizePrinterModel(value, fallback = null) {
  const model = String(value ?? fallback ?? '').trim().toUpperCase();
  if (!model) return null;
  if (!Object.values(PRINTER_MODELS).includes(model)) {
    throw new TypeError(
      `printerModel must be ${Object.values(PRINTER_MODELS).join(', ')}`,
    );
  }
  return model;
}

function normalizeRenderMode(value) {
  const mode = value || RENDER_MODES.PDF_RASTER;
  if (!Object.values(RENDER_MODES).includes(mode)) {
    throw new TypeError(
      `renderMode must be ${RENDER_MODES.PDF_RASTER} or ${RENDER_MODES.NATIVE_TSPL}`,
    );
  }
  return mode;
}

function resolvePrintRoute(printerModel, renderMode) {
  const model = normalizePrinterModel(printerModel);
  if (!model) throw new TypeError('printerModel is required');
  if (model !== PRINTER_MODELS.OCOM) return PRINT_ROUTES.RAW_ZPL;
  return normalizeRenderMode(renderMode) === RENDER_MODES.PDF_RASTER
    ? PRINT_ROUTES.OCOM_PDF_RASTER
    : PRINT_ROUTES.OCOM_NATIVE_TSPL;
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
    printerModel: normalizePrinterModel(
      saved.printerModel ?? process.env.PRINTER_MODEL ?? null,
    ),
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
  PRINT_ROUTES,
  PRINTER_MODELS,
  RENDER_MODES,
  loadConfig,
  normalizePrinterModel,
  normalizeRenderMode,
  resolvePrintRoute,
  saveConfig,
};
