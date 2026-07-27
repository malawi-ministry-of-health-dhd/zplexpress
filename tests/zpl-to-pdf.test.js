'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeHexField,
  renderZplToPdf,
  tokenize,
} = require('../zpl-to-pdf');

const LABEL_4_X_1_5 = {
  pageSize: 'w288h108',
  widthMm: 101.6,
  heightMm: 38.1,
  widthDots: 812,
  heightDots: 305,
  dpi: 203,
};

test('tokenizes ZPL fields and decodes ^FH values', () => {
  assert.deepEqual(tokenize('^XA^FO10,5^FH_^FDJohn_20Doe^FS^XZ'), [
    { command: '^XA', args: '' },
    { command: '^FO', args: '10,5' },
    { command: '^FH', args: '_' },
    { command: '^FD', args: 'John_20Doe' },
    { command: '^FS', args: '' },
    { command: '^XZ', args: '' },
  ]);
  assert.equal(decodeHexField('John_20Doe'), 'John Doe');
});

test('renders the long ^FB medical label to one exact-size PDF page', async () => {
  const zpl = '^XA^PW750^LL450'
    + '^FO20,20^FB700,10,5,L,0^A0N,30,30'
    + '^FDVISIT: 26 Jul, 2026 (Getrude Milepa) | VITALS: Ht 120cm, BP 120/70, '
    + 'Temp 37C, P 70, RR 20, SpO2 80% | MAIN DIAGNOSIS: Urinary disease | '
    + 'MEDICATIONS: Ciprofloxacin (500mg tablet) 1tab(s) BD (Qty: 20), '
    + 'Ibuprofen (400mg tablet) 1tab(s) TDS (Qty: 18)^FS^FS^XZ';

  const rendered = await renderZplToPdf(zpl, LABEL_4_X_1_5);
  const pdfText = rendered.pdf.toString('latin1');

  assert.equal(rendered.pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(rendered.pages, 1);
  assert.equal(rendered.media.pageSize, 'w288h108');
  assert.match(pdfText, /\/MediaBox \[0 0 288 108\]/);
});

test('renders Code 128 and honors ^PQ copies', async () => {
  const zpl = '^XA^FO20,20^A0N,30,30^FDJohn Doe^FS'
    + '^FO20,80^BY3^BCN,150,N,N,N^FDP100100000025^FS^PQ2^XZ';
  const rendered = await renderZplToPdf(zpl, LABEL_4_X_1_5);

  assert.equal(rendered.pages, 1);
  assert.equal(rendered.copies, 2);
  assert.ok(rendered.pdf.length > 5000);
  assert.deepEqual(rendered.warnings, []);
});

test('rejects non-ZPL input', async () => {
  await assert.rejects(
    () => renderZplToPdf('not a label', LABEL_4_X_1_5),
    /at least one \^XA/,
  );
});
