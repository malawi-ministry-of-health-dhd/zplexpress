'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PRINT_ROUTES,
  PRINTER_MODELS,
  normalizePrinterModel,
  normalizeRenderMode,
  resolvePrintRoute,
} = require('../config');

test('accepts the three supported printer models case-insensitively', () => {
  assert.equal(normalizePrinterModel('argox'), PRINTER_MODELS.ARGOX);
  assert.equal(normalizePrinterModel('zebra'), PRINTER_MODELS.ZEBRA);
  assert.equal(normalizePrinterModel('ocom'), PRINTER_MODELS.OCOM);
});

test('rejects unknown printer models and renderer modes', () => {
  assert.throws(() => normalizePrinterModel('generic'), /ARGOX, ZEBRA, OCOM/);
  assert.throws(() => normalizeRenderMode('RawZPL'), /PDFRaster or NativeTSPL/);
});

test('routes ARGOX/ZEBRA directly and only applies renderers to OCOM', () => {
  assert.equal(
    resolvePrintRoute(PRINTER_MODELS.ARGOX, 'ignored'),
    PRINT_ROUTES.RAW_ZPL,
  );
  assert.equal(
    resolvePrintRoute(PRINTER_MODELS.ZEBRA, 'ignored'),
    PRINT_ROUTES.RAW_ZPL,
  );
  assert.equal(
    resolvePrintRoute(PRINTER_MODELS.OCOM, 'PDFRaster'),
    PRINT_ROUTES.OCOM_PDF_RASTER,
  );
  assert.equal(
    resolvePrintRoute(PRINTER_MODELS.OCOM, 'NativeTSPL'),
    PRINT_ROUTES.OCOM_NATIVE_TSPL,
  );
});
