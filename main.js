
require('dotenv').config();

const express = require('express');
const { execFile, spawn } = require('child_process');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

const platform = process.platform;

console.log(`Starting server on port ${port}`);
console.log(`Detected OS: ${platform}`);

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// --------------------------------------------------
// WINDOWS HELPERS
// --------------------------------------------------

function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encoded
      ],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(stderr || error.message));
        }

        resolve(stdout.trim());
      }
    );
  });
}

// Get installed Windows printers
async function getWindowsPrinters() {
  const script = `
    $ErrorActionPreference = 'Stop'
    $printers = @(Get-Printer | ForEach-Object { $_.Name })
    ConvertTo-Json -InputObject $printers -Compress
  `;

  const output = await runPowerShell(script);

  if (!output) return [];

  const printers = JSON.parse(output);

  return Array.isArray(printers) ? printers : [printers];
}

// Print RAW ZPL through Windows printer spooler
async function printWindows(printerName, zpl) {
  const printer64 = Buffer.from(printerName, 'utf8').toString('base64');
  const zpl64 = Buffer.from(zpl, 'utf8').toString('base64');

  const script = `
    $ErrorActionPreference = 'Stop'

    try {
      $printerName = [Text.Encoding]::UTF8.GetString(
        [Convert]::FromBase64String('${printer64}')
      )

      $data = [Convert]::FromBase64String('${zpl64}')

      Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public class RawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFO
    {
        public string pDocName;
        public string pOutputFile;
        public string pDataType;
    }

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);

    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool ClosePrinter(IntPtr handle);

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern int StartDocPrinter(IntPtr handle, int level, DOCINFO info);

    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool EndDocPrinter(IntPtr handle);

    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool StartPagePrinter(IntPtr handle);

    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool EndPagePrinter(IntPtr handle);

    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool WritePrinter(
        IntPtr handle,
        byte[] data,
        int count,
        out int written
    );

    static void Check(bool result)
    {
        if (!result)
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static void Print(string printerName, byte[] data)
    {
        IntPtr handle;

        Check(OpenPrinter(printerName, out handle, IntPtr.Zero));

        int job = 0;
        bool pageStarted = false;

        try
        {
            DOCINFO info = new DOCINFO();
            info.pDocName = "ZPL Express Label";
            info.pDataType = "RAW";

            job = StartDocPrinter(handle, 1, info);

            if (job == 0)
                throw new Win32Exception(Marshal.GetLastWin32Error());

            Check(StartPagePrinter(handle));
            pageStarted = true;

            int written;
            Check(WritePrinter(handle, data, data.Length, out written));

            if (written != data.Length)
                throw new Exception("Incomplete printer write");

            Check(EndPagePrinter(handle));
            pageStarted = false;

            Check(EndDocPrinter(handle));
            job = 0;
        }
        finally
        {
            if (pageStarted) EndPagePrinter(handle);
            if (job != 0) EndDocPrinter(handle);
            ClosePrinter(handle);
        }
    }
}
'@

      [RawPrinter]::Print($printerName, $data)

    } catch {
      [Console]::Error.WriteLine($_.Exception.Message)
      exit 1
    }
  `;

  await runPowerShell(script);
}

// --------------------------------------------------
// LINUX / MACOS HELPERS (CUPS)
// --------------------------------------------------

function getCupsPrinters() {
  return new Promise((resolve, reject) => {
    execFile('lpstat', ['-p'], (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message));
      }

      const printers = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('printer'))
        .map(line => {
          const match = line.match(/^printer\s+(\S+)/);
          return match ? match[1] : null;
        })
        .filter(Boolean);

      resolve(printers);
    });
  });
}

function printCups(printerName, zpl) {
  return new Promise((resolve, reject) => {
    const printProcess = spawn('lp', [
      '-d',
      printerName,
      '-o',
      'raw'
    ]);

    let stderr = '';

    printProcess.stderr.on('data', data => {
      stderr += data.toString();
    });

    printProcess.on('error', reject);

    printProcess.on('close', code => {
      if (code !== 0) {
        return reject(new Error(stderr || `lp exited with code ${code}`));
      }

      resolve();
    });

    printProcess.stdin.on('error', reject);
    printProcess.stdin.end(zpl);
  });
}

// --------------------------------------------------
// PRINTER DISCOVERY
// --------------------------------------------------

async function getPrinters() {
  if (platform === 'win32') {
    return await getWindowsPrinters();
  }

  if (platform === 'linux' || platform === 'darwin') {
    return await getCupsPrinters();
  }

  throw new Error(`Unsupported operating system: ${platform}`);
}

// --------------------------------------------------
// SELECT PRINTER
// --------------------------------------------------

function selectPrinter(printers) {
  const configuredPrinter = process.env.PRINTER_NAME;

  if (configuredPrinter) {
    const match = printers.find(
      p => p.toLowerCase() === configuredPrinter.toLowerCase()
    );

    if (!match) {
      throw new Error(
        `Configured printer "${configuredPrinter}" was not found`
      );
    }

    return match;
  }

  return printers.find(p => /(zebra|zdesigner)/i.test(p)) || null;
}

// --------------------------------------------------
// API ROUTES
// --------------------------------------------------

app.get('/test', (req, res) => {
  res.status(200).json({
    status: 'Server is running!',
    platform,
    os: platform === 'win32' ? 'Windows' :
        platform === 'darwin' ? 'macOS' : 'Linux'
  });
});

// List available printers
app.get('/printers', async (req, res) => {
  try {
    const printers = await getPrinters();

    res.json({
      platform,
      printers
    });
  } catch (error) {
    console.error('Printer discovery error:', error.message);

    res.status(500).json({
      error: 'Could not list printers',
      details: error.message
    });
  }
});

// Print ZPL
app.post('/print', async (req, res) => {
  const { zpl } = req.body;

  if (!zpl || typeof zpl !== 'string' || zpl.trim() === '') {
    return res.status(400).json({
      error: 'ZPL data is required in the request body'
    });
  }

  try {
    const printers = await getPrinters();

    const printerName = selectPrinter(printers);

    if (!printerName) {
      return res.status(400).json({
        error: 'No Zebra printer found. Set PRINTER_NAME in .env',
        availablePrinters: printers
      });
    }

    console.log(`Using printer: ${printerName}`);

    if (platform === 'win32') {
      await printWindows(printerName, zpl);
    } else {
      await printCups(printerName, zpl);
    }

    console.log(`Successfully submitted ZPL to ${printerName}`);

    res.status(200).json({
      success: true,
      message: `Label sent to printer: ${printerName}`,
      printer: printerName,
      platform
    });

  } catch (error) {
    console.error('Printing error:', error);

    res.status(500).json({
      error: 'Failed to print label',
      details: error.message
    });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
