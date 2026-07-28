'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCsv,
  renderEplToPdf,
  tokenizeEpl,
} = require('../epl-to-pdf');

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

const MAHIS_ACCESSION_EPL = [
  'N',
  'q600',
  'Q230,20',
  'R130,0',
  'ZT',
  'S1',
  'A100,6,0,3,1,1,N,"Test ddddfff (M)"',
  'B100,30,0,1,3,8,80,N,"XAPP267M7"',
  'A100,118,0,3,1,1,N,"XAPP267M7   P1001"',
  'A100,142,0,3,1,1,N,"21/JUL/2026 Gram stain"',
  'A80,6,1,1,1,1,R," Urgent "',
  'P1',
].join('\n');

test('parses EPL quoted values without losing commas or escaped quotes', () => {
  assert.deepEqual(
    parseCsv('20,30,0,3,1,1,N,"Doe, John"'),
    ['20', '30', '0', '3', '1', '1', 'N', 'Doe, John'],
  );
  assert.deepEqual(tokenizeEpl('\r\nN\r\nq600\r\nP1\r\n'), ['N', 'q600', 'P1']);
});

test('renders the real MAHIS accession EPL to one exact-size PDF label', async () => {
  const rendered = await renderEplToPdf(MAHIS_ACCESSION_EPL, LABEL_4_X_1_5);
  const pdfText = rendered.pdf.toString('latin1');

  assert.equal(rendered.pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(rendered.pages, 1);
  assert.equal(rendered.copies, 1);
  assert.equal(rendered.media.pageSize, 'w288h108');
  assert.match(pdfText, /\/MediaBox \[0 0 288 108\]/);
  assert.ok(rendered.pdf.length > 5000);
  assert.deepEqual(rendered.warnings, []);
});

test('renders MAHIS lines, multiple labels, and EPL P copies', async () => {
  const label = [
    'N',
    'q801',
    'Q329,026',
    'ZT',
    'A20,10,0,2,1,1,N,"Visit: 2026-07-28"',
    'LO20,38,760,2',
    'X20,45,2,780,220',
    'P2',
  ].join('\n');
  const rendered = await renderEplToPdf(`${label}\n${label}`, LABEL_4_X_1_5);
  const pageMatches = rendered.pdf.toString('latin1').match(/\/Type \/Page\b/g) || [];

  assert.equal(rendered.pages, 2);
  assert.equal(rendered.copies, 2);
  assert.equal(pageMatches.length, 2);
});

test('locks the reported EPL sample to one top-left-anchored label page', async () => {
  const epl = [
    'N',
    'q801',
    'Q329,026',
    'ZT',
    'B50,110,0,1,3,8,120,N,"P100100000025"',
    'A35,30,0,3,1,1,N,"John Banda (M)"',
    'A35,76,0,3,1,1,N,"MRN: P100100000025  DOB: 1969-03-11"',
    'P1',
  ].join('\n');
  const rendered = await renderEplToPdf(epl, LABEL_4_X_1_57);
  const pdfText = rendered.pdf.toString('latin1');
  const physicalPages = pdfText.match(/\/Type \/Page\b/g) || [];

  assert.equal(rendered.pages, 1);
  assert.equal(rendered.copies, 1);
  assert.equal(physicalPages.length, 1);
  assert.deepEqual(rendered.contentOrigins, [{ x: 35, y: 30 }]);
  for (const box of ['MediaBox', 'CropBox', 'TrimBox', 'BleedBox', 'ArtBox']) {
    assert.match(pdfText, new RegExp(`/${box} \\[0 0 288 113\\]`));
  }
  assert.match(pdfText, /0 0 288 113 re\s+W n/);
  assert.match(pdfText, /1 0 0 1 0 \d+(?:\.\d+)? Tm/);
  assert.deepEqual(rendered.warnings, []);
});

test('keeps the rotated reverse-video Urgent flag on the accession label', async () => {
  const rendered = await renderEplToPdf(MAHIS_ACCESSION_EPL, LABEL_4_X_1_57);
  const pdfText = rendered.pdf.toString('latin1');

  // " Urgent " normalizes to x=0 and is rotated 90 degrees. Rotating about the
  // origin alone put its whole cell at negative x, where the label clip threw
  // it away. Font 1 is 12 dots high, so the field is translated back by
  // 12 dots (4.2562 pt) and stays on the label.
  assert.match(pdfText, /1 0 0 1 4\.25\d+ 0 cm/);
  assert.deepEqual(rendered.warnings, []);
});

test('drops empty EPL label formats instead of feeding blank labels', async () => {
  const epl = [
    'N', 'q801', 'Q329,026', 'P1',
    'N', 'ZT', 'A35,30,0,3,1,1,N,"HELLO"', 'P1',
  ].join('\n');
  const rendered = await renderEplToPdf(epl, LABEL_4_X_1_57);
  const physicalPages = rendered.pdf.toString('latin1').match(/\/Type \/Page\b/g) || [];

  assert.equal(rendered.pages, 1);
  assert.equal(physicalPages.length, 1);
  assert.match(rendered.warnings.join(' | '), /Skipped 1 empty EPL label format/);
});

test('keeps content origins aligned with their own label after an empty format', async () => {
  const epl = [
    'N', 'q801', 'P1',
    'N', 'ZT', 'A35,30,0,3,1,1,N,"HELLO"', 'P1',
  ].join('\n');
  const rendered = await renderEplToPdf(epl, LABEL_4_X_1_57);

  // The skipped format still owns contentOrigins[0]; the drawn label must use
  // its own origin, not the placeholder left by the empty one.
  assert.deepEqual(rendered.contentOrigins, [{ x: 0, y: 0 }, { x: 35, y: 30 }]);
  assert.match(rendered.pdf.toString('latin1'), /1 0 0 1 0 \d+(?:\.\d+)? Tm/);
});

test('rejects input without a complete EPL label frame', async () => {
  await assert.rejects(
    () => renderEplToPdf('A20,20,0,3,1,1,N,"not framed"', LABEL_4_X_1_5),
    /N \.\.\. P/,
  );
});
