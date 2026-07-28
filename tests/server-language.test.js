'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../main');

const EPL = [
  'N',
  'q600',
  'Q230,20',
  'R130,0',
  'A100,6,0,3,1,1,N,"EPL TEST"',
  'B100,30,0,1,3,8,80,N,"P1001"',
  'P1',
].join('\n');

function writeCommand(directory, name, contents) {
  const filename = path.join(directory, name);
  fs.writeFileSync(filename, `#!/bin/sh\n${contents}`, { mode: 0o755 });
}

test('OCOM PDFRaster detects EPL, renders PDF, and submits that PDF to CUPS', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zplexpress-epl-server-'));
  const oldPath = process.env.PATH;
  const argsFile = path.join(tempDir, 'lp-args');
  const inputFile = path.join(tempDir, 'lp-input');
  let httpServer;

  writeCommand(tempDir, 'lpstat', [
    'case "$1" in',
    '  -p) printf "%s\\n" "printer OCOM_Ubuntu_Driver is idle. enabled since now" ;;',
    '  -v) printf "%s\\n" "device for OCOM_Ubuntu_Driver: usb://LabelPrinter/OCBP-T4201?serial=ABC123" ;;',
    '  -o) exit 0 ;;',
    'esac',
  ].join('\n'));
  writeCommand(
    tempDir,
    'lpinfo',
    'printf "%s\\n" "direct usb://LabelPrinter/OCBP-T4201?serial=ABC123"\n',
  );
  writeCommand(tempDir, 'lpoptions', 'printf "%s\\n" "PageSize=w288h108"\n');
  writeCommand(tempDir, 'lp', [
    'printf "%s\\n" "$@" > "$ZPL_TEST_ARGS"',
    'cat > "$ZPL_TEST_INPUT"',
    'printf "%s\\n" "request id is OCOM_Ubuntu_Driver-55 (1 file(s))"',
  ].join('\n'));

  process.env.PATH = `${tempDir}:${oldPath}`;
  process.env.ZPL_TEST_ARGS = argsFile;
  process.env.ZPL_TEST_INPUT = inputFile;
  try {
    ({ httpServer } = await startServer({
      printerName: 'OCOM_Ubuntu_Driver',
      printerModel: 'OCOM',
      port: 0,
      renderMode: 'PDFRaster',
      persist: false,
    }));
    const port = httpServer.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zpl: EPL }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.commandLanguage, 'EPL');
    assert.equal(body.jobId, 'OCOM_Ubuntu_Driver-55');
    assert.match(body.driver, /EPL → PDFRaster/);
    assert.equal(body.media.pageSize, 'w288h108');
    assert.match(fs.readFileSync(argsFile, 'utf8'), /document-format=application\/pdf/);
    assert.match(fs.readFileSync(argsFile, 'utf8'), /PageSize=w288h108/);
    assert.equal(
      fs.readFileSync(inputFile).subarray(0, 5).toString('ascii'),
      '%PDF-',
    );
  } finally {
    if (httpServer) await new Promise(resolve => httpServer.close(resolve));
    process.env.PATH = oldPath;
    delete process.env.ZPL_TEST_ARGS;
    delete process.env.ZPL_TEST_INPUT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('OCOM NativeTSPL rejects EPL with a PDFRaster instruction', async () => {
  const { httpServer } = await startServer({
    printerName: 'OCOM_Ubuntu_Driver',
    printerModel: 'OCOM',
    port: 0,
    renderMode: 'NativeTSPL',
    persist: false,
  });
  const port = httpServer.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zpl: EPL }),
    });
    const body = await response.json();

    assert.equal(response.status, 422);
    assert.equal(body.commandLanguage, 'EPL');
    assert.equal(body.printed, false);
    assert.match(body.message, /Select the PDFRaster renderer/);
  } finally {
    await new Promise(resolve => httpServer.close(resolve));
  }
});

test('language detection endpoint inspects content in the legacy zpl field', async () => {
  const { httpServer } = await startServer({
    printerName: null,
    printerModel: 'ZEBRA',
    port: 0,
    renderMode: 'PDFRaster',
    persist: false,
  });
  const port = httpServer.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/detect-language`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zpl: EPL }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.language, 'EPL');
    assert.equal(body.confidence, 'high');
  } finally {
    await new Promise(resolve => httpServer.close(resolve));
  }
});
