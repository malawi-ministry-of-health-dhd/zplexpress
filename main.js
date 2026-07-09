require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const cors = require('cors');

const { loadConfig } = require('./config');
const { listPrinters, printerExists, getPrinterStatus, listJobs } = require('./printers');
const { runWizard } = require('./setup');

async function main() {
  // `node main.js setup` launches the interactive configuration wizard.
  if (process.argv.includes('setup')) {
    await runWizard();
    process.exit(0);
  }

  let config = loadConfig();

  // Auto-fallback: if no printer has been configured yet, run the wizard once.
  if (!config.printerName) {
    console.log('No printer configured yet — starting setup.');
    config = await runWizard();
  }

  startServer(config);
}

function startServer(config) {
  const app = express();
  const { port, printerName } = config;

  console.log(`Starting server on port ${port} (printer: ${printerName})`);

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

  app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
  });
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
