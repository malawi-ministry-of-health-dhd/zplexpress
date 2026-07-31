'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeHexField,
  renderZplToPdf,
  rotateFieldOrigin,
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

const LABEL_4_X_1_57 = {
  pageSize: 'w288h113',
  widthMm: 101.6,
  heightMm: 113 * 25.4 / 72,
  widthDots: 812,
  heightDots: 319,
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
  assert.match(pdfText, /ZPLExpress label/);
  assert.match(pdfText, /ZPLExpress local ZPL-to-PDF renderer/);
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

test('defaults ZPL rendering to one exact 102 x 36 mm PDF label', async () => {
  const rendered = await renderZplToPdf(
    '^XA^FO10,5^A0N,30,30^FDDEFAULT MEDIA^FS^XZ',
  );
  const pdfText = rendered.pdf.toString('latin1');

  assert.deepEqual(rendered.media, {
    pageSize: 'OCOM102x36',
    widthMm: 102,
    heightMm: 36,
    widthDots: 815,
    heightDots: 288,
    dpi: 203,
  });
  for (const box of ['MediaBox', 'CropBox', 'TrimBox', 'BleedBox', 'ArtBox']) {
    assert.match(
      pdfText,
      new RegExp(`/${box} \\[0 0 289\\.133858 102\\.047244\\]`),
    );
  }
  assert.match(pdfText, /0 0 289\.133858 102\.047244 re\s+W n/);
});

test('locks ZPL to one label page and preserves its label-home and field margins', async () => {
  const rendered = await renderZplToPdf(
    '^XA^PW750^LL450^LH20,10^FO35,30^A0N,20,20^FDTOP LEFT^FS^PQ1^XZ',
    LABEL_4_X_1_57,
  );
  const pdfText = rendered.pdf.toString('latin1');
  const physicalPages = pdfText.match(/\/Type \/Page\b/g) || [];

  assert.equal(rendered.pages, 1);
  assert.equal(rendered.copies, 1);
  assert.equal(physicalPages.length, 1);
  assert.deepEqual(rendered.contentOrigins, [{ x: 55, y: 40 }]);
  for (const box of ['MediaBox', 'CropBox', 'TrimBox', 'BleedBox', 'ArtBox']) {
    assert.match(pdfText, new RegExp(`/${box} \\[0 0 288 113\\]`));
  }
  assert.match(pdfText, /0 0 288 113 re\s+W n/);
  assert.match(pdfText, /1 0 0 1 19\.507389 93\.719606 Tm/);
});

test('anchors a rotated field by the top-left corner of the rotated field', () => {
  const calls = [];
  const doc = {
    translate: (x, y) => calls.push(['translate', x, y]),
    rotate: (degrees, options) => calls.push(['rotate', degrees, options.origin]),
  };

  // An unrotated field already starts at its origin.
  rotateFieldOrigin(doc, 0, 10, 20, 100, 12);
  assert.deepEqual(calls, []);

  // Rotating about the origin alone would push these into negative
  // coordinates, where the label clip discards them.
  rotateFieldOrigin(doc, 90, 10, 20, 100, 12);
  assert.deepEqual(calls, [['translate', 12, 0], ['rotate', 90, [10, 20]]]);

  calls.length = 0;
  rotateFieldOrigin(doc, 180, 10, 20, 100, 12);
  assert.deepEqual(calls, [['translate', 100, 12], ['rotate', 180, [10, 20]]]);

  calls.length = 0;
  rotateFieldOrigin(doc, 270, 10, 20, 100, 12);
  assert.deepEqual(calls, [['translate', 0, 100], ['rotate', 270, [10, 20]]]);
});

test('drops empty ZPL label formats instead of feeding blank labels', async () => {
  const rendered = await renderZplToPdf(
    '^XA^JUS^XZ^XA^FO50,50^A0N,30,30^FDHELLO^FS^XZ^XA^XZ',
    LABEL_4_X_1_57,
  );
  const physicalPages = rendered.pdf.toString('latin1').match(/\/Type \/Page\b/g) || [];

  assert.equal(rendered.pages, 1);
  assert.equal(physicalPages.length, 1);
  assert.match(rendered.warnings.join(' | '), /Skipped 2 empty ZPL label format/);
});

test('does not let an empty format inflate the copy count', async () => {
  const rendered = await renderZplToPdf(
    '^XA^PQ5^XZ^XA^FO50,50^A0N,30,30^FDHELLO^FS^XZ',
    LABEL_4_X_1_57,
  );

  assert.equal(rendered.pages, 1);
  assert.equal(rendered.copies, 1);
});

for (const [description, zpl] of [
  ['malformed graphics', '^XA^FO0,0^GFA^XZ'],
  ['unsupported graphic compression', '^XA^FO0,0^GFB,1,1,1,FF^XZ'],
  [
    'content wholly outside the configured label',
    '^XA^FO0,0^GB0,0,1,B^FS^FO999,999^FDOUTSIDE^FS^XZ',
  ],
  ['an all-white box on an empty label', '^XA^FO0,0^GB20,20,2,W^FS^XZ'],
  ['an all-white bitmap', '^XA^FO0,0^GFA,2,2,1,0000^XZ'],
]) {
  test(`does not create a PDF page for ${description}`, async () => {
    await assert.rejects(
      () => renderZplToPdf(zpl, LABEL_4_X_1_57),
      /No ZPL label format contained anything to print/,
    );
  });
}

test('rejects a ZPL stream whose label formats all print nothing', async () => {
  await assert.rejects(
    () => renderZplToPdf('^XA^JUS^XZ^XA^XZ', LABEL_4_X_1_57),
    /anything to print/,
  );
});

test('rejects non-ZPL input', async () => {
  await assert.rejects(
    () => renderZplToPdf('not a label', LABEL_4_X_1_5),
    /at least one \^XA/,
  );
});
