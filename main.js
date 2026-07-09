require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const cors = require('cors');

const app = express();
const port = process.env.PORT ?? 3000;

console.log(`Starting server on port ${port}`);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get("/test", (req, res) => {
  res.status(200).json({ status: "Server is running!!!" });
});

app.post('/print', (req, res) => {
  const { zpl } = req.body;

  if (!zpl || typeof zpl !== 'string' || zpl.trim() === '') {
    return res.status(400).json({ error: 'ZPL data is required in the request body' });
  }

  // Step 1: Detect Zebra printer
  exec('lpstat -p', (err, stdout, stderr) => {
    if (err) {
      console.error('Failed to list printers:', stderr);
      return res.status(500).json({ error: 'Could not list printers' });
    }

    // Parse printers
    const printers = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('printer'))
      .map(line => {
        const match = line.match(/^printer\s+(\S+)/);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    const zebraPrinter = printers.find(p => /zebra/i.test(p));
    const printerName = zebraPrinter || process.env.PRINTER_NAME;

    if (!printerName) {
      console.error('No Zebra printer found and PRINTER_NAME not set in environment.');
      return res.status(400).json({ error: 'No printer found. Please connect a Zebra printer or set PRINTER_NAME in .env' });
    }

    console.log(`Using printer: ${printerName}`);

    const lpCommand = `lp -d ${printerName} -o raw`;

    const printProcess = exec(lpCommand, (error, stdout, stderr) => {
      if (error) {
        console.error(`Print error: ${error}`);
        return res.status(500).json({ error: 'Failed to print label' });
      }

      console.log(`Print stdout: ${stdout}`);
      if (stderr) console.error(`Print stderr: ${stderr}`);

      res.status(200).json({ message: `Label sent to printer: ${printerName}` });
    });

    // Send ZPL via stdin to avoid shell quoting issues
    printProcess.stdin.write(zpl);
    printProcess.stdin.end();
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
