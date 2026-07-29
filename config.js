const fs = require('fs');
const path = require('path');

// Config location is overridable via ZPL_CONFIG (used by the packaged
// install, which stores config in /etc/zplexpress/config.json).
const CONFIG_PATH = process.env.ZPL_CONFIG || path.join(__dirname, 'config.json');
const PRINTER_MODELS = Object.freeze({
  ARGOX: 'ARGOX',
  ZEBRA: 'ZEBRA',
  OCOM: 'OCOM',
});
const PRINT_ROUTES = Object.freeze({
  RAW_COMMANDS: 'RawCommands',
  OCOM_DRIVER: 'OCOMDriver',
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

function resolvePrintRoute(printerModel) {
  const model = normalizePrinterModel(printerModel);
  if (!model) throw new TypeError('printerModel is required');
  return model === PRINTER_MODELS.OCOM
    ? PRINT_ROUTES.OCOM_DRIVER
    : PRINT_ROUTES.RAW_COMMANDS;
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
  loadConfig,
  normalizePrinterModel,
  resolvePrintRoute,
  saveConfig,
};
