const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { PRINTER_MODELS } = require('./config');

const execFileAsync = promisify(execFile);

const OCOM_QUEUE = process.env.OCOM_PRINTER_NAME || 'OCOM_Ubuntu_Driver';
const OCOM_ZPL_FORMAT = 'application/vnd.ocom-zpl';
const PDF_FORMAT = 'application/pdf';
const DEFAULT_MEDIA_NAME = 'w288h113';
const DEFAULT_MEDIA = Object.freeze({
  pageSize: DEFAULT_MEDIA_NAME,
  widthMm: 101.6,
  heightMm: 113 * 25.4 / 72,
  widthDots: 812,
  heightDots: 319,
  dpi: 203,
});
const COMMAND_OPTIONS = { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000 };

function commandOutput(error) {
  return `${error.stdout || ''}\n${error.stderr || ''}`;
}

function isEmptyCupsResult(error) {
  return /no destinations added|no printers found|no entries/i.test(commandOutput(error));
}

function parsePrinters(stdout) {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('printer '))
    .map(line => {
      const match = line.match(/^printer\s+(\S+)\s+(.*)$/);
      return match ? { name: match[1], status: match[2] } : null;
    })
    .filter(Boolean);
}

function parseDeviceUri(stdout) {
  const match = stdout.match(/^device for\s+[^:]+:\s+(\S.*)$/m);
  return match ? match[1].trim() : null;
}

function parseConnectedDeviceUris(stdout) {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^\S+\s+(\S.*)$/);
      return match ? match[1].trim() : null;
    })
    .filter(Boolean);
}

function parseLpOptions(stdout) {
  const options = {};
  for (const token of String(stdout || '').trim().split(/\s+/)) {
    const separator = token.indexOf('=');
    if (separator > 0) {
      options[token.slice(0, separator)] = token.slice(separator + 1);
    }
  }
  return options;
}

function parseMarkedLpOption(stdout, optionNames = ['PageSize', 'media']) {
  const accepted = new Set(optionNames.map(name => String(name).toLowerCase()));
  for (const sourceLine of String(stdout || '').split('\n')) {
    const line = sourceLine.trim();
    const separator = line.indexOf(':');
    if (separator < 1) continue;

    const option = line
      .slice(0, separator)
      .split('/', 1)[0]
      .trim()
      .toLowerCase();
    if (!accepted.has(option)) continue;

    const marked = line
      .slice(separator + 1)
      .trim()
      .split(/\s+/)
      .find(choice => choice.startsWith('*') && choice.length > 1);
    if (marked) return marked.slice(1);
  }
  return null;
}

function parsePageSize(pageSize) {
  const value = String(pageSize || '');
  let match = value.match(/^w(\d+(?:\.\d+)?)h(\d+(?:\.\d+)?)$/i);
  if (match) {
    const widthPoints = Number(match[1]);
    const heightPoints = Number(match[2]);
    return {
      pageSize: value,
      widthMm: widthPoints * 25.4 / 72,
      heightMm: heightPoints * 25.4 / 72,
      widthDots: Math.round(widthPoints * 203 / 72),
      heightDots: Math.round(heightPoints * 203 / 72),
      dpi: 203,
    };
  }

  match = value.match(/^Custom\.(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(mm|cm|in|pt)?$/i);
  if (match) {
    const units = (match[3] || 'pt').toLowerCase();
    const scaleToMm = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72 }[units];
    const widthMm = Number(match[1]) * scaleToMm;
    const heightMm = Number(match[2]) * scaleToMm;
    return {
      pageSize: value,
      widthMm,
      heightMm,
      widthDots: Math.round(widthMm * 203 / 25.4),
      heightDots: Math.round(heightMm * 203 / 25.4),
      dpi: 203,
    };
  }

  const aliases = {
    '4x6': { widthMm: 101.6, heightMm: 152.4 },
    '4x1.5': { widthMm: 101.6, heightMm: 38.1 },
    '4x1.57': { widthMm: 101.6, heightMm: 113 * 25.4 / 72 },
  };
  const alias = aliases[value.toLowerCase()];
  if (!alias) return null;
  return {
    pageSize: value,
    ...alias,
    widthDots: Math.round(alias.widthMm * 203 / 25.4),
    heightDots: Math.round(alias.heightMm * 203 / 25.4),
    dpi: 203,
  };
}

function decodeUri(uri) {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

function normalizeDeviceUri(uri) {
  return decodeUri(String(uri || '').trim()).toLowerCase().replace(/\/+$/, '');
}

function isUsbDeviceUri(uri) {
  return /^usb:/i.test(String(uri || '').trim());
}

// CUPS can add or omit a USB query string while enumerating a device. Match
// the queryless forms only when one side has no query; if both serial numbers
// are present they must agree, so identical printer models are not confused.
function usbDeviceMatches(configuredUri, connectedUri) {
  const configured = normalizeDeviceUri(configuredUri);
  const connected = normalizeDeviceUri(connectedUri);
  if (!configured || !connected) return false;
  if (configured === connected) return true;

  const [configuredBase, configuredQuery] = configured.split('?', 2);
  const [connectedBase, connectedQuery] = connected.split('?', 2);
  return configuredBase === connectedBase && (!configuredQuery || !connectedQuery);
}

function isOcomPrinter(name, deviceUri = '') {
  const queueName = String(name || '');
  if (queueName.toLowerCase() === OCOM_QUEUE.toLowerCase()) return true;
  if (/^ocom(?:[_-]|$)/i.test(queueName)) return true;

  const identity = normalizeDeviceUri(deviceUri);
  return /(?:ocom|ocbp[-_ ]?t?4201)/i.test(identity);
}

function detectPrinterModel(name, deviceUri = '') {
  const identity = `${String(name || '')} ${normalizeDeviceUri(deviceUri)}`;
  if (isOcomPrinter(name, deviceUri)) return PRINTER_MODELS.OCOM;
  if (/\bargox\b/i.test(identity)) return PRINTER_MODELS.ARGOX;
  if (/\bzebra\b/i.test(identity)) return PRINTER_MODELS.ZEBRA;

  // Unknown ZPL-compatible queues use raw ZPL. The user can identify the
  // queue as ARGOX or ZEBRA in the dashboard without changing that behavior.
  return PRINTER_MODELS.ZEBRA;
}

// List printers registered with CUPS via `lpstat -p`.
async function listPrinters() {
  try {
    const { stdout } = await execFileAsync('lpstat', ['-p'], COMMAND_OPTIONS);
    return parsePrinters(stdout);
  } catch (error) {
    if (isEmptyCupsResult(error)) return [];
    throw error;
  }
}

// Return the system default printer name, or null if none is set.
async function getDefaultPrinter() {
  try {
    const { stdout } = await execFileAsync('lpstat', ['-d'], COMMAND_OPTIONS);
    const match = stdout.match(/system default destination:\s+(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Check whether a CUPS queue with the given name is registered. This does not
// imply that its physical USB device is connected; use getPrinterStatus for
// readiness.
async function printerExists(name) {
  if (!name) return false;
  const printers = await listPrinters();
  return printers.some(printer => printer.name === name);
}

async function getPrinterDeviceUri(name) {
  if (!name) return null;

  try {
    const { stdout } = await execFileAsync('lpstat', ['-v', name], COMMAND_OPTIONS);
    return parseDeviceUri(stdout);
  } catch (error) {
    if (/unknown destination|not found/i.test(commandOutput(error))) return null;
    throw error;
  }
}

async function getPrinterMedia(name) {
  if (!name) return { ...DEFAULT_MEDIA, source: 'default' };

  let normalOptionsAvailable = false;
  try {
    const { stdout } = await execFileAsync('lpoptions', ['-p', name], COMMAND_OPTIONS);
    normalOptionsAvailable = true;
    const options = parseLpOptions(stdout);
    const pageSize = options.PageSize || options.media;
    const media = parsePageSize(pageSize);
    if (media) return { ...media, source: 'cups' };
  } catch (error) {
    if (/unknown destination|not found/i.test(commandOutput(error))) {
      return { ...DEFAULT_MEDIA, source: 'default' };
    }
    throw error;
  }

  // Some CUPS queues omit PageSize from the compact option output. The
  // detailed PPD list marks the active choice with an asterisk:
  //   PageSize/Media Size: *w288h108 w288h432 Custom.WIDTHxHEIGHT
  try {
    const { stdout } = await execFileAsync(
      'lpoptions',
      ['-p', name, '-l'],
      COMMAND_OPTIONS,
    );
    const media = parsePageSize(parseMarkedLpOption(stdout));
    if (media) return { ...media, source: 'cups-detailed' };
  } catch (error) {
    if (!normalOptionsAvailable && !/unknown destination|not found/i.test(commandOutput(error))) {
      throw error;
    }
  }

  return { ...DEFAULT_MEDIA, source: 'default' };
}

async function listConnectedDeviceUris() {
  // Restrict discovery to USB so the status poll does not wait for network
  // printer discovery backends.
  const { stdout } = await execFileAsync(
    'lpinfo',
    ['--include-schemes', 'usb', '--timeout', '3', '-v'],
    COMMAND_OPTIONS,
  );
  return parseConnectedDeviceUris(stdout);
}

// Return queue state and, for direct USB queues, whether the corresponding
// physical device is currently visible to CUPS.
async function getPrinterStatus(name) {
  if (!name) {
    return {
      available: false,
      queueAvailable: false,
      enabled: false,
      connected: false,
      state: 'not configured',
      reason: 'No printer is configured',
      deviceUri: null,
      isOcom: false,
      detectedModel: null,
      driver: null,
      activeJobId: null,
    };
  }

  const printer = (await listPrinters()).find(candidate => candidate.name === name);
  if (!printer) {
    return {
      available: false,
      queueAvailable: false,
      enabled: false,
      connected: false,
      state: 'CUPS queue not found',
      reason: `The CUPS queue "${name}" is not installed`,
      deviceUri: null,
      isOcom: isOcomPrinter(name),
      detectedModel: detectPrinterModel(name),
      driver: isOcomPrinter(name) ? 'OCOM ZPL-to-TSPL' : 'Raw ZPL',
      activeJobId: null,
    };
  }

  const deviceUri = await getPrinterDeviceUri(name);
  const usbQueue = isUsbDeviceUri(deviceUri);
  let connected = usbQueue ? false : null;
  let connectionCheckError = null;

  if (usbQueue) {
    try {
      const devices = await listConnectedDeviceUris();
      connected = devices.some(uri => isUsbDeviceUri(uri) && usbDeviceMatches(deviceUri, uri));
    } catch (error) {
      // Do not reject jobs merely because a CUPS backend cannot enumerate
      // devices. The queue remains usable, but the dashboard reports that the
      // physical connection could not be verified.
      connected = null;
      connectionCheckError = error.message;
    }
  }

  const enabled = !/\bdisabled\b/i.test(printer.status);
  const available = enabled && connected !== false;
  const printing = printer.status.match(/now printing\s+([^\s.]+)/i);
  const ocom = isOcomPrinter(name, deviceUri);
  const detectedModel = detectPrinterModel(name, deviceUri);

  let reason = 'Connection is managed by CUPS';
  if (!enabled) reason = 'The CUPS queue is disabled';
  else if (connected === true) reason = 'USB printer connected';
  else if (connected === false) reason = 'USB printer is unplugged or powered off';
  else if (connectionCheckError) reason = 'Could not verify the USB connection';

  return {
    available,
    queueAvailable: true,
    enabled,
    connected,
    state: printer.status,
    reason,
    deviceUri,
    isOcom: ocom,
    detectedModel,
    driver: ocom ? 'OCOM ZPL-to-TSPL' : `${detectedModel} raw ZPL`,
    activeJobId: printing ? printing[1] : null,
    connectionCheckError,
  };
}

// Find a registered OCOM queue, preferring the standard queue name installed
// by the ocom-ocbp-t4201-driver package.
async function findOcomPrinter() {
  const printers = await listPrinters();
  const preferred = printers.find(printer => printer.name === OCOM_QUEUE);
  if (preferred) return preferred.name;

  for (const printer of printers) {
    const deviceUri = await getPrinterDeviceUri(printer.name);
    if (isOcomPrinter(printer.name, deviceUri)) return printer.name;
  }

  return null;
}

function buildPrintArgs(printerName, useOcomDriver) {
  if (!printerName || typeof printerName !== 'string') {
    throw new TypeError('A printer name is required');
  }

  const args = ['-d', printerName, '-t', 'ZPLExpress label'];
  if (useOcomDriver) {
    args.push('-o', `document-format=${OCOM_ZPL_FORMAT}`);
  } else {
    args.push('-o', 'raw');
  }
  args.push('-');
  return args;
}

function buildPdfPrintArgs(printerName, media = DEFAULT_MEDIA, copies = 1) {
  if (!printerName || typeof printerName !== 'string') {
    throw new TypeError('A printer name is required');
  }

  const args = [
    '-d', printerName,
    '-t', 'ZPLExpress PDF label',
    '-n', String(Math.max(1, Math.min(999, Math.round(Number(copies) || 1)))),
    '-o', `document-format=${PDF_FORMAT}`,
    '-o', `PageSize=${media.pageSize || DEFAULT_MEDIA_NAME}`,
    '-o', 'fit-to-page=false',
    '-o', 'scaling=100',
    '-',
  ];
  return args;
}

function submitBuffer(args, data) {
  return new Promise((resolve, reject) => {
    const child = spawn('lp', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdinError = null;
    let settled = false;

    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', error => { stdinError = error; });
    child.once('error', fail);
    child.once('close', code => {
      if (settled) return;
      if (code !== 0 || stdinError) {
        const detail = stderr.trim()
          || (stdinError && stdinError.message)
          || `lp exited with status ${code}`;
        return fail(new Error(detail));
      }

      settled = true;
      const match = stdout.match(/request id is\s+(\S+)/i);
      resolve({
        jobId: match ? match[1] : null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.stdin.end(data);
  });
}

// Submit through lp without a shell. OCOM data is tagged with the custom MIME
// type so CUPS invokes zpl_to_tspl; true Zebra queues continue to receive raw
// ZPL.
function submitZpl(printerName, zpl, useOcomDriver) {
  return submitBuffer(buildPrintArgs(printerName, useOcomDriver), zpl);
}

function submitPdf(printerName, pdf, media, copies = 1) {
  if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return Promise.reject(new TypeError('submitPdf requires a PDF Buffer'));
  }
  return submitBuffer(buildPdfPrintArgs(printerName, media, copies), pdf);
}

// List queued print jobs (not yet completed) via `lpstat -o`.
async function listJobs(activeJobId = null) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('lpstat', ['-o'], COMMAND_OPTIONS));
  } catch (error) {
    if (isEmptyCupsResult(error)) return [];
    throw error;
  }

  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [id, user, size, ...rest] = line.split(/\s+/);
      return {
        id,
        user,
        size,
        submitted: rest.join(' '),
        state: id === activeJobId ? 'running' : 'pending',
      };
    });
}

module.exports = {
  OCOM_QUEUE,
  OCOM_ZPL_FORMAT,
  PDF_FORMAT,
  DEFAULT_MEDIA,
  buildPdfPrintArgs,
  buildPrintArgs,
  detectPrinterModel,
  findOcomPrinter,
  getDefaultPrinter,
  getPrinterDeviceUri,
  getPrinterMedia,
  getPrinterStatus,
  isOcomPrinter,
  listConnectedDeviceUris,
  listJobs,
  listPrinters,
  normalizeDeviceUri,
  parseConnectedDeviceUris,
  parseDeviceUri,
  parseLpOptions,
  parseMarkedLpOption,
  parsePageSize,
  parsePrinters,
  printerExists,
  submitPdf,
  submitZpl,
  usbDeviceMatches,
};
