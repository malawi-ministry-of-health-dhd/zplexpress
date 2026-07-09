const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

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
    port: saved.port ?? Number(process.env.PORT) ?? 3000,
  };
}

// Persist configuration to config.json.
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

module.exports = { loadConfig, saveConfig, CONFIG_PATH };
