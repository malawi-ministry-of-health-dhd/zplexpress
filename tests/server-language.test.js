'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer } = require('../main');

const EPL = [
  'N',
  'q600',
  'Q230,20',
  'A20,20,0,3,1,1,N,"EPL TEST"',
  'P1',
].join('\n');

test('OCOM rejects detected EPL before submitting anything to CUPS', async () => {
  const { httpServer } = await startServer({
    printerName: 'OCOM_Ubuntu_Driver',
    printerModel: 'OCOM',
    port: 0,
    renderMode: 'PDFRaster',
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
    assert.match(body.message, /EPL-to-TSPL or EPL-to-PDF translator/);
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
