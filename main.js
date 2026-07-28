'use strict';

require('dotenv').config();
const path = require('path');
const net = require('net');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const {
  PRINT_ROUTES,
  PRINTER_MODELS,
  RENDER_MODES,
  loadConfig,
  normalizePrinterModel,
  normalizeRenderMode,
  resolvePrintRoute,
  saveConfig,
} = require('./config');
const {
  detectPrinterModel,
  findOcomPrinter,
  getPrinterMedia,
  getPrinterStatus,
  listJobs,
  listPrinters,
  printerExists,
  submitPdf,
  submitZpl,
} = require('./printers');
const { runWizard } = require('./setup');
const { renderZplToPdf } = require('./zpl-to-pdf');
const { renderEplToPdf } = require('./epl-to-pdf');
const {
  COMMAND_LANGUAGES,
  detectCommandLanguage,
  extractCommandData,
} = require('./command-language');

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

function inspectCommandRequest(body) {
  const commands = extractCommandData(body);
  return {
    commands,
    detection: detectCommandLanguage(commands),
  };
}

function describePrintPath(printerModel, renderMode, commandLanguage = null) {
  if (printerModel === PRINTER_MODELS.OCOM) {
    return renderMode === RENDER_MODES.PDF_RASTER
      ? `OCOM ${commandLanguage || 'ZPL/EPL'} → PDFRaster → CUPS raster → TSPL`
      : 'OCOM NativeTSPL → ZPL-to-TSPL';
  }
  return `${printerModel} raw ${commandLanguage || 'ZPL/EPL'}`;
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
        config = {
          ...config,
          printerName: ocomPrinter,
          printerModel: PRINTER_MODELS.OCOM,
        };
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
  let printerModel = normalizePrinterModel(config.printerModel)
    || detectPrinterModel(config.printerName);
  let currentPort = config.port;
  let renderMode = normalizeRenderMode(config.renderMode);
  let lastCommand = null;
  let httpServer;

  const persistConfig = () => {
    if (config.persist === false) return;
    saveConfig({
      printerName,
      printerModel,
      port: currentPort,
      renderMode,
    });
  };

  console.log(
    `Starting server (preferred port: ${currentPort}, printer: ${printerName}, model: ${printerModel})`,
  );

  async function ensurePrinterSelection() {
    if (printerName && await printerExists(printerName)) return printerName;

    const ocomPrinter = await findOcomPrinter();
    if (ocomPrinter) {
      printerName = ocomPrinter;
      printerModel = PRINTER_MODELS.OCOM;
      persistConfig();
      console.log(`Detected and selected OCOM printer: ${printerName}`);
    }
    return printerName;
  }

  async function renderLabel(commands, commandLanguage) {
    await ensurePrinterSelection();
    const media = await getPrinterMedia(printerName);
    let rendered;
    if (commandLanguage === COMMAND_LANGUAGES.ZPL) {
      rendered = await renderZplToPdf(commands, media);
    } else if (commandLanguage === COMMAND_LANGUAGES.EPL) {
      rendered = await renderEplToPdf(commands, media);
    } else {
      throw new TypeError('The command language must be identified as ZPL or EPL');
    }
    if (media.source === 'default') {
      rendered.warnings.push(
        'CUPS PageSize was unavailable; used the default 101.6 x 39.9 mm media',
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
      const driver = describePrintPath(printerModel, renderMode);
      res.status(200).json({
        service: 'running',
        port: currentPort,
        printerModel,
        renderMode,
        lastCommand,
        printer: {
          name: printerName,
          ...printer,
          selectedModel: printerModel,
          driver,
        },
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

  app.post('/detect-language', (req, res) => {
    try {
      const { detection } = inspectCommandRequest(req.body);
      return res.status(200).json(detection);
    } catch (error) {
      return res.status(400).json({ error: error.message, message: error.message });
    }
  });

  app.get('/printers', async (req, res) => {
    try {
      await ensurePrinterSelection();
      const printers = await listPrinters();
      const statuses = await Promise.all(
        printers.map(printer => getPrinterStatus(printer.name)),
      );
      res.status(200).json({
        configured: printerName,
        configuredModel: printerModel,
        printers: printers.map((printer, index) => ({
          ...printer,
          isOcom: statuses[index].isOcom,
          detectedModel: statuses[index].detectedModel,
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
      const status = await getPrinterStatus(name);
      printerName = name;
      printerModel = status.detectedModel || detectPrinterModel(name);
      persistConfig();
      console.log(`Active printer changed to: ${name} (${printerModel})`);
      return res.status(200).json({
        message: `Active printer set to ${name} as ${printerModel}`,
        printerName: name,
        printerModel,
      });
    } catch (error) {
      console.error(`Could not select printer: ${error.message}`);
      return res.status(500).json({ error: 'Could not read printers from CUPS' });
    }
  });

  app.post('/printer-model', (req, res) => {
    try {
      const selectedModel = normalizePrinterModel(req.body.printerModel);
      if (!selectedModel) throw new TypeError('printerModel is required');
      printerModel = selectedModel;
      persistConfig();
      console.log(`Printer model changed to: ${printerModel}`);
      return res.status(200).json({
        message: `Printer model set to ${printerModel}`,
        printerModel,
        renderMode: printerModel === PRINTER_MODELS.OCOM ? renderMode : 'RawZPL',
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post('/render-mode', (req, res) => {
    try {
      if (printerModel !== PRINTER_MODELS.OCOM) {
        return res.status(400).json({
          error: 'OCOM renderer can only be selected when printerModel is OCOM',
        });
      }
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
      const { commands, detection } = inspectCommandRequest(req.body);
      const supported = [
        COMMAND_LANGUAGES.ZPL,
        COMMAND_LANGUAGES.EPL,
      ].includes(detection.language);
      lastCommand = {
        ...detection,
        outcome: supported
          ? 'PDF preview rendered'
          : 'PDF preview rejected',
        detectedAt: new Date().toISOString(),
      };
      if (!supported) {
        const message = 'The command language could not be identified as ZPL or EPL.';
        return res.status(415).json({
          error: message,
          message,
          commandLanguage: detection.language,
          printed: false,
        });
      }

      const rendered = await renderLabel(commands, detection.language);
      const languageHeader = `X-${detection.language}`;
      res
        .status(200)
        .type('application/pdf')
        .set('Content-Disposition', 'inline; filename="zplexpress-label.pdf"')
        .set('X-Command-Language', detection.language)
        .set(`${languageHeader}-Pages`, String(rendered.pages))
        .set(
          `${languageHeader}-Warnings`,
          encodeURIComponent(rendered.warnings.join(' | ')).slice(0, 4000),
        )
        .send(rendered.pdf);
    } catch (error) {
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 500;
      res.status(status).json({ error: `Failed to render label: ${error.message}` });
    }
  });

  app.post('/print', async (req, res) => {
    let commands;
    let detection;
    let requestedMode = null;
    try {
      ({ commands, detection } = inspectCommandRequest(req.body));
      lastCommand = {
        ...detection,
        outcome: 'received',
        detectedAt: new Date().toISOString(),
      };

      if (printerModel === PRINTER_MODELS.OCOM) {
        requestedMode = normalizeRenderMode(req.body.renderMode ?? renderMode);
        console.log(
          `Detected ${detection.language} command language for the OCOM print request`,
        );
        if (
          detection.language === COMMAND_LANGUAGES.EPL
          && requestedMode !== RENDER_MODES.PDF_RASTER
        ) {
          const message = 'EPL commands were detected, but OCOM NativeTSPL only translates ZPL. Select the PDFRaster renderer to convert EPL to PDF before printing.';
          lastCommand.outcome = 'rejected: EPL requires OCOM PDFRaster';
          return res.status(422).json({
            error: message,
            message,
            commandLanguage: detection.language,
            confidence: detection.confidence,
            printed: false,
          });
        }
        if (![COMMAND_LANGUAGES.ZPL, COMMAND_LANGUAGES.EPL].includes(detection.language)) {
          const message = 'The command language could not be identified as ZPL or EPL. The OCOM job was not printed.';
          lastCommand.outcome = 'rejected: unknown command language';
          return res.status(415).json({
            error: message,
            message,
            commandLanguage: detection.language,
            confidence: detection.confidence,
            printed: false,
          });
        }
      }

    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    try {
      await ensurePrinterSelection();
      const printer = await getPrinterStatus(printerName);

      if (!printer.queueAvailable) {
        const setupHint = printerModel === PRINTER_MODELS.OCOM
          ? 'Install the OCOM driver or select another printer.'
          : 'Install or select its CUPS queue.';
        return res.status(503).json({
          error: printerName
            ? `The CUPS queue "${printerName}" is not installed. ${setupHint}`
            : 'No printer is configured. Select a CUPS printer from the dashboard.',
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
        return res.status(503).json({
          error: `${printerModel} printer "${printerName}" is unplugged or powered off. Connect it by USB and try again.`,
          printer,
        });
      }

      let result;
      let driver;
      let warnings = [];
      let media = null;
      const route = resolvePrintRoute(printerModel, requestedMode);
      if (route === PRINT_ROUTES.OCOM_PDF_RASTER) {
        const rendered = await renderLabel(commands, detection.language);
        result = await submitPdf(
          printerName,
          rendered.pdf,
          rendered.media,
          rendered.copies,
        );
        driver = describePrintPath(printerModel, requestedMode, detection.language);
        warnings = rendered.warnings;
        media = rendered.media;
      } else if (route === PRINT_ROUTES.OCOM_NATIVE_TSPL) {
        result = await submitZpl(printerName, commands, true);
        driver = describePrintPath(printerModel, requestedMode, detection.language);
      } else {
        // ARGOX and ZEBRA receive the detected ZPL or EPL bytes unchanged.
        result = await submitZpl(printerName, commands, false);
        driver = `${printerModel} raw ${detection.language}`;
      }

      lastCommand.outcome = 'submitted';
      lastCommand.jobId = result.jobId;
      console.log(
        `Submitted ${detection.language} ${result.jobId || 'print job'} to ${printerName} using ${driver}`,
      );
      return res.status(200).json({
        message: `Label sent to printer: ${printerName}`,
        jobId: result.jobId,
        driver,
        printerModel,
        commandLanguage: detection.language,
        confidence: detection.confidence,
        renderMode: printerModel === PRINTER_MODELS.OCOM ? requestedMode : 'RawZPL',
        media,
        warnings,
      });
    } catch (error) {
      if (lastCommand && lastCommand.outcome === 'received') {
        lastCommand.outcome = `failed: ${error.message}`;
      }
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
  return { app, httpServer };
}

if (require.main === module) {
  main().catch(error => {
    if (error && error.name === 'ExitPromptError') {
      console.log('\nSetup cancelled.');
      process.exit(0);
    }
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  inspectCommandRequest,
  startServer,
};
