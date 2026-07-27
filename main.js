'use strict';

require('dotenv').config();
const path = require('path');
const net = require('net');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const {
  RENDER_MODES,
  loadConfig,
  normalizeRenderMode,
  saveConfig,
} = require('./config');
const {
  findOcomPrinter,
  getPrinterMedia,
  getPrinterStatus,
  isOcomPrinter,
  listJobs,
  listPrinters,
  printerExists,
  submitPdf,
  submitZpl,
} = require('./printers');
const { runWizard } = require('./setup');
const { renderZplToPdf } = require('./zpl-to-pdf');

function isPortFree(port) {
  return new Promise(resolve => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '0.0.0.0');
  });
}

async function findAvailablePort(desired, maxTries = 50) {
  for (let port = desired; port < desired + maxTries && port <= 65535; port += 1) {
    if (await isPortFree(port)) return port;
  }
  return 0;
}

function validateZpl(value) {
  if (!value || typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('ZPL data is required in the request body');
  }
  return value;
}

async function main() {
  if (process.argv.includes('setup')) {
    await runWizard();
    process.exit(0);
  }

  let config = loadConfig();

  try {
    const configuredQueueExists = config.printerName
      && await printerExists(config.printerName);
    if (!configuredQueueExists) {
      const ocomPrinter = await findOcomPrinter();
      if (ocomPrinter) {
        config = { ...config, printerName: ocomPrinter };
        saveConfig(config);
        console.log(`Automatically selected OCOM printer: ${ocomPrinter}`);
      }
    }
  } catch (error) {
    console.warn(`Could not auto-detect the OCOM printer: ${error.message}`);
  }

  if (!config.printerName) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      console.log('No printer configured yet — starting setup.');
      config = await runWizard();
    } else {
      console.warn(
        'No printer configured. Select one from the dashboard at "/" or run `zplexpress setup`.',
      );
    }
  }

  await startServer(config);
}

async function startServer(config) {
  const app = express();
  let printerName = config.printerName;
  let currentPort = config.port;
  let renderMode = normalizeRenderMode(config.renderMode);
  let httpServer;

  const persistConfig = () => saveConfig({ printerName, port: currentPort, renderMode });

  console.log(
    `Starting server (preferred port: ${currentPort}, printer: ${printerName}, renderer: ${renderMode})`,
  );

  async function ensurePrinterSelection() {
    if (printerName && await printerExists(printerName)) return printerName;

    const ocomPrinter = await findOcomPrinter();
    if (ocomPrinter) {
      printerName = ocomPrinter;
      persistConfig();
      console.log(`Detected and selected OCOM printer: ${printerName}`);
    }
    return printerName;
  }

  async function renderLabel(zpl) {
    await ensurePrinterSelection();
    const media = await getPrinterMedia(printerName);
    const rendered = await renderZplToPdf(zpl, media);
    if (media.source === 'default') {
      rendered.warnings.push(
        'CUPS PageSize was unavailable; used the default 101.6 x 38.1 mm media',
      );
    }
    return rendered;
  }

  app.use(cors());
  app.use(bodyParser.json({ limit: '6mb' }));
  app.use(bodyParser.urlencoded({ extended: true, limit: '6mb' }));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  });

  app.get('/status', async (req, res) => {
    try {
      await ensurePrinterSelection();
      const printer = await getPrinterStatus(printerName);
      const jobs = await listJobs(printer.activeJobId);
      res.status(200).json({
        service: 'running',
        port: currentPort,
        renderMode,
        printer: { name: printerName, ...printer },
        jobs,
      });
    } catch (error) {
      console.error('Failed to read status:', error.message);
      res.status(500).json({ error: 'Could not read printer status' });
    }
  });

  app.get('/test', (req, res) => {
    res.status(200).json({ status: 'Server is running' });
  });

  app.get('/printers', async (req, res) => {
    try {
      await ensurePrinterSelection();
      const printers = await listPrinters();
      res.status(200).json({
        configured: printerName,
        printers: printers.map(printer => ({
          ...printer,
          isOcom: isOcomPrinter(printer.name),
        })),
      });
    } catch {
      res.status(500).json({ error: 'Could not list printers' });
    }
  });

  app.post('/printer', async (req, res) => {
    const name = req.body.printerName;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'printerName is required' });
    }

    try {
      if (!(await printerExists(name))) {
        return res.status(400).json({ error: `CUPS queue "${name}" is not installed` });
      }
      printerName = name;
      persistConfig();
      console.log(`Active printer changed to: ${name}`);
      return res.status(200).json({
        message: `Active printer set to ${name}`,
        printerName: name,
      });
    } catch (error) {
      console.error(`Could not select printer: ${error.message}`);
      return res.status(500).json({ error: 'Could not read printers from CUPS' });
    }
  });

  app.post('/render-mode', (req, res) => {
    try {
      renderMode = normalizeRenderMode(req.body.renderMode);
      persistConfig();
      console.log(`OCOM render mode changed to: ${renderMode}`);
      return res.status(200).json({
        message: `Render mode set to ${renderMode}`,
        renderMode,
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post('/port', (req, res) => {
    const newPort = Number(req.body.port);
    if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) {
      return res.status(400).json({
        error: 'Port must be an integer between 1 and 65535',
      });
    }
    if (newPort === currentPort) {
      return res.status(200).json({ message: 'Port unchanged', port: currentPort });
    }

    const newServer = app.listen(newPort);
    newServer.once('listening', () => {
      const oldServer = httpServer;
      httpServer = newServer;
      currentPort = newPort;
      persistConfig();
      console.log(`Port changed to ${newPort}`);
      oldServer.close();
      res.status(200).json({ message: `Port changed to ${newPort}`, port: newPort });
    });
    newServer.once('error', error => {
      res.status(500).json({
        error: `Could not bind port ${newPort}: ${error.code || error.message}`,
      });
    });
  });

  // Render without printing. This makes it possible to inspect the exact PDF
  // that will enter CUPS and is useful when tuning a label layout.
  app.post('/render', async (req, res) => {
    try {
      const zpl = validateZpl(req.body.zpl);
      const rendered = await renderLabel(zpl);
      res
        .status(200)
        .type('application/pdf')
        .set('Content-Disposition', 'inline; filename="zplexpress-label.pdf"')
        .set('X-ZPL-Pages', String(rendered.pages))
        .set(
          'X-ZPL-Warnings',
          encodeURIComponent(rendered.warnings.join(' | ')).slice(0, 4000),
        )
        .send(rendered.pdf);
    } catch (error) {
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 500;
      res.status(status).json({ error: `Failed to render label: ${error.message}` });
    }
  });

  app.post('/print', async (req, res) => {
    let zpl;
    let requestedMode;
    try {
      zpl = validateZpl(req.body.zpl);
      requestedMode = normalizeRenderMode(req.body.renderMode ?? renderMode);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    try {
      await ensurePrinterSelection();
      const printer = await getPrinterStatus(printerName);

      if (!printer.queueAvailable) {
        return res.status(503).json({
          error: printerName
            ? `The CUPS queue "${printerName}" is not installed. Install the OCOM driver or select another printer.`
            : 'No printer is configured. Install the OCOM driver or select a printer from the dashboard.',
          printer,
        });
      }
      if (!printer.enabled) {
        return res.status(503).json({
          error: `Printer "${printerName}" is disabled in CUPS. Enable it before printing.`,
          printer,
        });
      }
      if (printer.connected === false) {
        const printerType = printer.isOcom ? 'OCOM printer' : 'USB printer';
        return res.status(503).json({
          error: `${printerType} "${printerName}" is unplugged or powered off. Connect it by USB and try again.`,
          printer,
        });
      }

      let result;
      let driver;
      let warnings = [];
      let media = null;
      if (printer.isOcom && requestedMode === RENDER_MODES.PDF_RASTER) {
        const rendered = await renderLabel(zpl);
        result = await submitPdf(
          printerName,
          rendered.pdf,
          rendered.media,
          rendered.copies,
        );
        driver = 'OCOM PDFRaster → CUPS raster → TSPL';
        warnings = rendered.warnings;
        media = rendered.media;
      } else {
        result = await submitZpl(printerName, zpl, printer.isOcom);
        driver = printer.driver;
      }

      console.log(
        `Submitted ${result.jobId || 'print job'} to ${printerName} using ${driver}`,
      );
      return res.status(200).json({
        message: `Label sent to printer: ${printerName}`,
        jobId: result.jobId,
        driver,
        renderMode: printer.isOcom ? requestedMode : 'RawZPL',
        media,
        warnings,
      });
    } catch (error) {
      console.error(`Print error: ${error.message}`);
      return res.status(500).json({
        error: `Failed to print label: ${error.message}`,
      });
    }
  });

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
    persistConfig();
  }
  console.log(`Server is running on http://localhost:${currentPort}`);
}

main().catch(error => {
  if (error && error.name === 'ExitPromptError') {
    console.log('\nSetup cancelled.');
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
});
