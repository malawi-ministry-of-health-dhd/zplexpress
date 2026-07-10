require('dotenv').config();
const path = require('path');
const net = require('net');
const express = require('express');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const cors = require('cors');

const { loadConfig, saveConfig } = require('./config');
const { listPrinters, printerExists, getPrinterStatus, listJobs } = require('./printers');
const { runWizard } = require('./setup');

// Resolve whether a TCP port is free to bind.
function isPortFree(port) {
  return new Promise(resolve => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '0.0.0.0');
  });
}

// Find an available port, starting at `desired` and scanning upward.
// Returns 0 (OS-assigned) if none is free in the scanned range.
async function findAvailablePort(desired, maxTries = 50) {
  for (let p = desired; p < desired + maxTries && p <= 65535; p++) {
    if (await isPortFree(p)) return p;
  }
  return 0;
}

async function main() {
  // `node main.js setup` launches the interactive configuration wizard.
  if (process.argv.includes('setup')) {
    await runWizard();
    process.exit(0);
  }

  let config = loadConfig();

  // Auto-fallback: if no printer is configured, run the wizard — but only when
  // attached to a terminal. Under systemd (no TTY) start anyway; the printer
  // can be selected from the dashboard or via `zplexpress setup`.
  if (!config.printerName) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      console.log('No printer configured yet — starting setup.');
      config = await runWizard();
    } else {
      console.warn('No printer configured. Select one from the dashboard at "/" or run `zplexpress setup`.');
    }
  }

  await startServer(config);
}

async function startServer(config) {
  const app = express();
  // Mutable so they can be changed at runtime from the dashboard.
  let printerName = config.printerName;
  let currentPort = config.port;
  let httpServer;

  console.log(`Starting server (preferred port: ${currentPort}, printer: ${printerName})`);

  app.use(cors());
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));

  // Status dashboard.
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  });

  // Service + printer + job status as JSON (polled by the dashboard).
  app.get('/status', async (req, res) => {
    try {
      const printer = await getPrinterStatus(printerName);
      const jobs = await listJobs(printer.activeJobId);
      res.status(200).json({
        service: 'running',
        port: currentPort,
        printer: { name: printerName, available: printer.available, state: printer.state },
        jobs,
      });
    } catch (err) {
      console.error('Failed to read status:', err.message);
      res.status(500).json({ error: 'Could not read printer status' });
    }
  });

  app.get('/test', (req, res) => {
    res.status(200).json({ status: 'Server is running!!!' });
  });

  app.get('/printers', async (req, res) => {
    try {
      const printers = await listPrinters();
      res.status(200).json({ configured: printerName, printers });
    } catch (err) {
      res.status(500).json({ error: 'Could not list printers' });
    }
  });

  // Change the active printer at runtime and persist it to config.json.
  app.post('/printer', async (req, res) => {
    const name = req.body.printerName;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'printerName is required' });
    }
    if (!(await printerExists(name))) {
      return res.status(400).json({ error: `Printer "${name}" is not available` });
    }

    printerName = name;
    saveConfig({ printerName: name, port: currentPort });
    console.log(`Active printer changed to: ${name}`);
    res.status(200).json({ message: `Active printer set to ${name}`, printerName: name });
  });

  // Change the listening port at runtime and persist it to config.json.
  // Binds the new port before closing the old one, so there is no downtime.
  app.post('/port', (req, res) => {
    const newPort = Number(req.body.port);

    if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) {
      return res.status(400).json({ error: 'Port must be an integer between 1 and 65535' });
    }
    if (newPort === currentPort) {
      return res.status(200).json({ message: 'Port unchanged', port: currentPort });
    }

    const newServer = app.listen(newPort);
    newServer.once('listening', () => {
      const oldServer = httpServer;
      httpServer = newServer;
      currentPort = newPort;
      saveConfig({ printerName, port: newPort });
      console.log(`Port changed to ${newPort}`);
      oldServer.close();
      res.status(200).json({ message: `Port changed to ${newPort}`, port: newPort });
    });
    newServer.once('error', err => {
      res.status(500).json({ error: `Could not bind port ${newPort}: ${err.code || err.message}` });
    });
  });

  app.post('/print', async (req, res) => {
    const { zpl } = req.body;

    if (!zpl || typeof zpl !== 'string' || zpl.trim() === '') {
      return res.status(400).json({ error: 'ZPL data is required in the request body' });
    }

    if (!(await printerExists(printerName))) {
      console.error(`Configured printer "${printerName}" is not available.`);
      return res.status(400).json({
        error: `Configured printer "${printerName}" is not available. Run \`node main.js setup\` to reconfigure.`,
      });
    }

    console.log(`Using printer: ${printerName}`);

    const printProcess = exec(`lp -d ${printerName} -o raw`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Print error: ${error}`);
        return res.status(500).json({ error: 'Failed to print label' });
      }

      console.log(`Print stdout: ${stdout}`);
      if (stderr) console.error(`Print stderr: ${stderr}`);

      res.status(200).json({ message: `Label sent to printer: ${printerName}` });
    });

    // Send ZPL via stdin to avoid shell quoting issues.
    printProcess.stdin.write(zpl);
    printProcess.stdin.end();
  });

  // If the preferred port is busy, fall back to a free one so the service
  // still starts. Persist whatever we actually bind to, so the dashboard,
  // the desktop launcher, and the next restart all agree on the port.
  const desiredPort = currentPort;
  const chosenPort = await findAvailablePort(desiredPort);

  await new Promise((resolve, reject) => {
    httpServer = app.listen(chosenPort);
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });

  currentPort = httpServer.address().port;
  if (currentPort !== desiredPort) {
    console.warn(`Port ${desiredPort} was busy — using free port ${currentPort} instead.`);
    saveConfig({ printerName, port: currentPort });
  }
  console.log(`Server is running on http://localhost:${currentPort}`);
}

main().catch(err => {
  // Raised by @inquirer when the user cancels the wizard (Ctrl+C).
  if (err && err.name === 'ExitPromptError') {
    console.log('\nSetup cancelled.');
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});
