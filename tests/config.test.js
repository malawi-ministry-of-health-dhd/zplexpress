'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PRINT_ROUTES,
  PRINTER_MODELS,
  normalizePrinterModel,
  resolvePrintRoute,
} = require('../config');

test('accepts the three supported printer models case-insensitively', () => {
  assert.equal(normalizePrinterModel('argox'), PRINTER_MODELS.ARGOX);
  assert.equal(normalizePrinterModel('zebra'), PRINTER_MODELS.ZEBRA);
  assert.equal(normalizePrinterModel('ocom'), PRINTER_MODELS.OCOM);
});

test('rejects unknown printer models', () => {
  assert.throws(() => normalizePrinterModel('generic'), /ARGOX, ZEBRA, OCOM/);
});

test('routes ARGOX/ZEBRA raw and all OCOM jobs through the installed driver', () => {
  assert.equal(
    resolvePrintRoute(PRINTER_MODELS.ARGOX),
    PRINT_ROUTES.RAW_COMMANDS,
  );
  assert.equal(
    resolvePrintRoute(PRINTER_MODELS.ZEBRA),
    PRINT_ROUTES.RAW_COMMANDS,
  );
  assert.equal(
    // A former PDFRaster value may still exist in an upgraded config. Extra
    // arguments are deliberately ignored and cannot change the OCOM route.
    resolvePrintRoute(PRINTER_MODELS.OCOM, 'PDFRaster'),
    PRINT_ROUTES.OCOM_DRIVER,
  );
});
