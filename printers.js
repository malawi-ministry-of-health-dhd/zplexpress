const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const OCOM_QUEUE = process.env.OCOM_PRINTER_NAME || 'OCOM_Ubuntu_Driver';
const OCOM_ZPL_FORMAT = 'application/vnd.ocom-zpl';
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
    driver: ocom ? 'OCOM ZPL-to-TSPL' : 'Raw ZPL',
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

// Submit through lp without a shell. OCOM data is tagged with the custom MIME
// type so CUPS invokes zpl_to_tspl; true Zebra queues continue to receive raw
// ZPL.
function submitZpl(printerName, zpl, useOcomDriver) {
  return new Promise((resolve, reject) => {
    const child = spawn('lp', buildPrintArgs(printerName, useOcomDriver), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
        const detail = stderr.trim() || (stdinError && stdinError.message) || `lp exited with status ${code}`;
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

    child.stdin.end(zpl);
  });
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
  buildPrintArgs,
  findOcomPrinter,
  getDefaultPrinter,
  getPrinterDeviceUri,
  getPrinterStatus,
  isOcomPrinter,
  listConnectedDeviceUris,
  listJobs,
  listPrinters,
  normalizeDeviceUri,
  parseConnectedDeviceUris,
  parseDeviceUri,
  parsePrinters,
  printerExists,
  submitZpl,
  usbDeviceMatches,
};
