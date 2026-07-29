const { select, input } = require('@inquirer/prompts');
const {
  OCOM_QUEUE,
  getDefaultPrinter,
  getPrinterStatus,
  listPrinters,
} = require('./printers');
const {
  PRINTER_MODELS,
  loadConfig,
  saveConfig,
} = require('./config');

// Interactive terminal wizard: detect connected printers, let the user pick
// one and set the server port, then persist the choice to config.json.
async function runWizard() {
  const current = loadConfig();

  console.log('\nDetecting connected printers...\n');

  let printers = [];
  try {
    printers = await listPrinters();
  } catch (err) {
    console.error('Failed to list printers via lpstat:', err.message);
    console.error('Make sure CUPS is installed and your printer is connected.');
    process.exit(1);
  }

  if (printers.length === 0) {
    console.error('No printers found. Connect a printer (and make sure it is');
    console.error('registered with CUPS), then run `node main.js setup` again.');
    process.exit(1);
  }

  const defaultPrinter = await getDefaultPrinter();
  const preselect = current.printerName
    ?? (printers.some(printer => printer.name === OCOM_QUEUE) ? OCOM_QUEUE : defaultPrinter);
  const statuses = await Promise.all(printers.map(printer => getPrinterStatus(printer.name)));

  console.log(`Found ${printers.length} printer(s).\n`);

  const printerName = await select({
    message: 'Select the printer to use:',
    choices: printers.map((printer, index) => ({
      name: `${printer.name} [${statuses[index].detectedModel}]`
        + `${statuses[index].connected === false ? ' [USB unplugged]' : ''}`
        + `  (${printer.status})`,
      value: printer.name,
    })),
    default: printers.some(p => p.name === preselect) ? preselect : undefined,
  });

  const selectedIndex = printers.findIndex(printer => printer.name === printerName);
  const detectedModel = statuses[selectedIndex].detectedModel;
  const printerModel = await select({
    message: 'Select the printer model:',
    choices: [
      { name: 'ARGOX — send ZPL/EPL directly', value: PRINTER_MODELS.ARGOX },
      { name: 'ZEBRA — send ZPL/EPL directly', value: PRINTER_MODELS.ZEBRA },
      { name: 'OCOM — use the OCOM ZPL/EPL driver', value: PRINTER_MODELS.OCOM },
    ],
    default: current.printerName === printerName && current.printerModel
      ? current.printerModel
      : detectedModel,
  });

  const portInput = await input({
    message: 'Port for the print server:',
    default: String(current.port),
    validate: value => {
      const n = Number(value);
      return Number.isInteger(n) && n > 0 && n < 65536
        ? true
        : 'Enter a valid port number (1-65535)';
    },
  });

  const config = {
    printerName,
    printerModel,
    port: Number(portInput),
  };
  saveConfig(config);

  console.log(`\nSaved configuration:`);
  console.log(`  Printer:  ${config.printerName}`);
  console.log(`  Model:    ${config.printerModel}`);
  console.log(`  Port:     ${config.port}\n`);

  return config;
}

module.exports = { runWizard };
