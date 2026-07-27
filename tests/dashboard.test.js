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
