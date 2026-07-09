const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// List printers registered with CUPS via `lpstat -p`.
// Returns an array of { name, status } objects.
async function listPrinters() {
  const { stdout } = await execAsync('lpstat -p');

  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('printer'))
    .map(line => {
      const match = line.match(/^printer\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      return { name: match[1], status: match[2] };
    })
    .filter(Boolean);
}

// Return the system default printer name, or null if none is set.
async function getDefaultPrinter() {
  try {
    const { stdout } = await execAsync('lpstat -d');
    const match = stdout.match(/system default destination:\s+(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Check whether a printer with the given name is currently available.
async function printerExists(name) {
  const printers = await listPrinters();
  return printers.some(p => p.name === name);
}

// Return the current status of a printer: whether it exists, its raw state
// string, and the id of the job it is actively printing (if any).
async function getPrinterStatus(name) {
  const printer = (await listPrinters()).find(p => p.name === name);
  if (!printer) {
    return { available: false, state: 'not found', activeJobId: null };
  }

  const printing = printer.status.match(/now printing\s+([^.\s]+)/);
  return {
    available: true,
    state: printer.status,
    activeJobId: printing ? printing[1] : null,
  };
}

// List queued print jobs (not yet completed) via `lpstat -o`.
// Each job is marked "running" if it is the printer's active job, else "pending".
async function listJobs(activeJobId = null) {
  const { stdout } = await execAsync('lpstat -o');

  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      // Format: <job-id> <user> <size> <submitted date...>
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

module.exports = { listPrinters, getDefaultPrinter, printerExists, getPrinterStatus, listJobs };
