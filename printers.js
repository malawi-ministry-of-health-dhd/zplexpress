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

module.exports = { listPrinters, getDefaultPrinter, printerExists };
