const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PDF_FORMAT,
  OCOM_ZPL_FORMAT,
  buildPdfPrintArgs,
  buildPrintArgs,
  detectPrinterModel,
  getPrinterStatus,
  isOcomPrinter,
  parseConnectedDeviceUris,
  parseDeviceUri,
  parseLpOptions,
  parsePageSize,
  parsePrinters,
  submitPdf,
  submitZpl,
  usbDeviceMatches,
} = require('../printers');

test('parses CUPS printer queues', () => {
  const printers = parsePrinters([
    'printer Office is idle. enabled since Friday',
    'printer OCOM_Ubuntu_Driver now printing OCOM_Ubuntu_Driver-12. enabled since Friday',
    '',
  ].join('\n'));

  assert.deepEqual(printers, [
    { name: 'Office', status: 'is idle. enabled since Friday' },
    {
      name: 'OCOM_Ubuntu_Driver',
      status: 'now printing OCOM_Ubuntu_Driver-12. enabled since Friday',
    },
  ]);
});

test('parses configured and currently connected CUPS device URIs', () => {
  assert.equal(
    parseDeviceUri('device for OCOM_Ubuntu_Driver: usb://LabelPrinter/OCBP-T4201?serial=ABC123\n'),
    'usb://LabelPrinter/OCBP-T4201?serial=ABC123',
  );

  assert.deepEqual(
    parseConnectedDeviceUris([
      'network ipp',
      'direct usb://LabelPrinter/OCBP-T4201?serial=ABC123',
      'network dnssd://Office._ipp._tcp.local/',
    ].join('\n')),
    [
      'ipp',
      'usb://LabelPrinter/OCBP-T4201?serial=ABC123',
      'dnssd://Office._ipp._tcp.local/',
    ],
  );
});

test('matches the connected USB printer without confusing serial numbers', () => {
  const configured = 'usb://LabelPrinter/OCBP-T4201?serial=ABC123';

  assert.equal(
    usbDeviceMatches(configured, 'usb://LabelPrinter/OCBP-T4201?serial=ABC123'),
    true,
  );
  assert.equal(usbDeviceMatches(configured, 'usb://LabelPrinter/OCBP-T4201'), true);
  assert.equal(
    usbDeviceMatches(configured, 'usb://LabelPrinter/OCBP-T4201?serial=OTHER'),
    false,
  );
});

test('recognizes the standard queue and OCBP-T4201 USB identity as OCOM', () => {
  assert.equal(isOcomPrinter('OCOM_Ubuntu_Driver'), true);
  assert.equal(
    isOcomPrinter('Shipping_Labels', 'usb://LabelPrinter/OCBP-T4201?serial=ABC123'),
    true,
  );
  assert.equal(isOcomPrinter('Zebra_GK420d', 'usb://Zebra/GK420d'), false);
});

test('detects OCOM, ARGOX, and ZEBRA printer models', () => {
  assert.equal(
    detectPrinterModel('OCOM_Ubuntu_Driver', 'usb://LabelPrinter/OCBP-T4201'),
    'OCOM',
  );
  assert.equal(
    detectPrinterModel('Argox_OS-2140', 'usb://Argox/OS-2140'),
    'ARGOX',
  );
  assert.equal(
    detectPrinterModel('Zebra_GK420d', 'usb://Zebra/GK420d'),
    'ZEBRA',
  );
  assert.equal(detectPrinterModel('Generic_ZPL_Printer'), 'ZEBRA');
});

test('routes OCOM through its MIME filter and ARGOX/ZEBRA as raw ZPL', () => {
  assert.deepEqual(buildPrintArgs('OCOM_Ubuntu_Driver', true), [
    '-d',
    'OCOM_Ubuntu_Driver',
    '-t',
    'ZPLExpress label',
    '-o',
    `document-format=${OCOM_ZPL_FORMAT}`,
    '-',
  ]);

  assert.deepEqual(buildPrintArgs('Zebra_GK420d', false), [
    '-d',
    'Zebra_GK420d',
    '-t',
    'ZPLExpress label',
    '-o',
    'raw',
    '-',
  ]);

  assert.deepEqual(buildPrintArgs('Argox_OS-2140', false), [
    '-d',
    'Argox_OS-2140',
    '-t',
    'ZPLExpress label',
    '-o',
    'raw',
    '-',
  ]);
});

test('parses the configured CUPS page size for PDF rendering', () => {
  assert.deepEqual(
    parseLpOptions('copies=1 PageSize=w288h108 ZPLFontMode=NoOversize'),
    { copies: '1', PageSize: 'w288h108', ZPLFontMode: 'NoOversize' },
  );

  assert.deepEqual(parsePageSize('w288h108'), {
    pageSize: 'w288h108',
    widthMm: 101.6,
    heightMm: 38.099999999999994,
    widthDots: 812,
    heightDots: 305,
    dpi: 203,
  });

  const custom = parsePageSize('Custom.50.8x25.4mm');
  assert.equal(custom.widthMm, 50.8);
  assert.equal(custom.heightMm, 25.4);
  assert.equal(custom.widthDots, 406);
  assert.equal(custom.heightDots, 203);
});

test('builds a size-locked CUPS PDF job', () => {
  const media = parsePageSize('w288h108');
  assert.deepEqual(buildPdfPrintArgs('OCOM_Ubuntu_Driver', media, 2), [
    '-d', 'OCOM_Ubuntu_Driver',
    '-t', 'ZPLExpress PDF label',
    '-n', '2',
    '-o', `document-format=${PDF_FORMAT}`,
    '-o', 'PageSize=w288h108',
    '-o', 'fit-to-page=false',
    '-o', 'scaling=100',
    '-',
  ]);
});

test('keeps a printer name as one lp argument instead of executing a shell', () => {
  const unsafeLookingName = 'printer; touch /tmp/should-not-exist';
  const args = buildPrintArgs(unsafeLookingName, true);

  assert.equal(args[1], unsafeLookingName);
  assert.equal(args.length, 7);
});

test('detects a plugged OCOM device and submits it through the translator', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zplexpress-test-'));
  const oldPath = process.env.PATH;
  const argsFile = path.join(tempDir, 'lp-args');
  const inputFile = path.join(tempDir, 'lp-input');

  function writeCommand(name, contents) {
    const filename = path.join(tempDir, name);
    fs.writeFileSync(filename, `#!/bin/sh\n${contents}`, { mode: 0o755 });
  }

  writeCommand('lpstat', [
    'case "$1" in',
    '  -p) printf "%s\\n" "printer OCOM_Ubuntu_Driver is idle. enabled since now" ;;',
    '  -v) printf "%s\\n" "device for OCOM_Ubuntu_Driver: usb://LabelPrinter/OCBP-T4201?serial=ABC123" ;;',
    '  -o) exit 0 ;;',
    'esac',
  ].join('\n'));
  writeCommand(
    'lpinfo',
    'printf "%s\\n" "direct usb://LabelPrinter/OCBP-T4201?serial=ABC123"\n',
  );
  writeCommand('lp', [
    'printf "%s\\n" "$@" > "$ZPL_TEST_ARGS"',
    'cat > "$ZPL_TEST_INPUT"',
    'printf "%s\\n" "request id is OCOM_Ubuntu_Driver-42 (1 file(s))"',
  ].join('\n'));

  process.env.PATH = `${tempDir}:${oldPath}`;
  process.env.ZPL_TEST_ARGS = argsFile;
  process.env.ZPL_TEST_INPUT = inputFile;

  try {
    const status = await getPrinterStatus('OCOM_Ubuntu_Driver');
    assert.equal(status.queueAvailable, true);
    assert.equal(status.connected, true);
    assert.equal(status.available, true);
    assert.equal(status.isOcom, true);

    const result = await submitZpl(
      'OCOM_Ubuntu_Driver',
      '^XA^FO20,20^FDJOHN DOE^FS^XZ',
      status.isOcom,
    );
    assert.equal(result.jobId, 'OCOM_Ubuntu_Driver-42');
    assert.ok(
      fs.readFileSync(argsFile, 'utf8').includes(`document-format=${OCOM_ZPL_FORMAT}`),
    );
    assert.equal(fs.readFileSync(inputFile, 'utf8'), '^XA^FO20,20^FDJOHN DOE^FS^XZ');
  } finally {
    process.env.PATH = oldPath;
    delete process.env.ZPL_TEST_ARGS;
    delete process.env.ZPL_TEST_INPUT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('submits generated PDF bytes through CUPS without a shell', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zplexpress-pdf-test-'));
  const oldPath = process.env.PATH;
  const argsFile = path.join(tempDir, 'lp-args');
  const inputFile = path.join(tempDir, 'lp-input');
  const lp = path.join(tempDir, 'lp');
  fs.writeFileSync(lp, [
    '#!/bin/sh',
    'printf "%s\\n" "$@" > "$ZPL_TEST_ARGS"',
    'cat > "$ZPL_TEST_INPUT"',
    'printf "%s\\n" "request id is OCOM_Ubuntu_Driver-43 (1 file(s))"',
  ].join('\n'), { mode: 0o755 });

  process.env.PATH = `${tempDir}:${oldPath}`;
  process.env.ZPL_TEST_ARGS = argsFile;
  process.env.ZPL_TEST_INPUT = inputFile;

  try {
    const pdf = Buffer.from('%PDF-1.3\nlocal-render\n%%EOF\n');
    const media = parsePageSize('w288h108');
    const result = await submitPdf('OCOM_Ubuntu_Driver', pdf, media, 1);

    assert.equal(result.jobId, 'OCOM_Ubuntu_Driver-43');
    assert.ok(fs.readFileSync(argsFile, 'utf8').includes(`document-format=${PDF_FORMAT}`));
    assert.ok(fs.readFileSync(argsFile, 'utf8').includes('PageSize=w288h108'));
    assert.deepEqual(fs.readFileSync(inputFile), pdf);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.ZPL_TEST_ARGS;
    delete process.env.ZPL_TEST_INPUT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
