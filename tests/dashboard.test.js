'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashboard = fs.readFileSync(
  path.join(__dirname, '..', 'dashboard.html'),
  'utf8',
);

test('OCOM renderer is initially hidden and only shown for the OCOM model', () => {
  assert.match(
    dashboard,
    /<div class="row" id="render-mode-row" hidden>/,
  );
  assert.match(dashboard, /\.row\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(
    dashboard,
    /renderModeRow\.hidden = printerModel !== 'OCOM';/,
  );
});

test('dashboard exposes the most recently detected command language', () => {
  assert.match(dashboard, /id="last-command-language"/);
  assert.match(dashboard, /lastCommand\.language \+ ' — ' \+ lastCommand\.outcome/);
});

test('dashboard offers the three 7.5 x 2.5 inch test print profiles', () => {
  assert.match(dashboard, /id="test-print-select"/);
  assert.match(dashboard, /Simple test print — ZPL/);
  assert.match(dashboard, /Barcode — EPL/);
  assert.match(dashboard, /Visit summary — EPL/);
  assert.match(dashboard, /\^PW1523/);
  assert.match(dashboard, /\^LL508/);
  assert.match(dashboard, /'q1523'/);
  assert.match(dashboard, /'Q508,026'/);
  assert.match(dashboard, /fetch\('\/print'/);
  assert.match(dashboard, /JSON\.stringify\(\{ commands: sample \}\)/);
  assert.match(dashboard, /OCOM OCBP-T4201 has a 4-inch-wide printhead/);
});
