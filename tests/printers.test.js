const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  OCOM_ZPL_FORMAT,
  buildPrintArgs,
  getPrinterStatus,
  isOcomPrinter,
  parseConnectedDeviceUris,
  parseDeviceUri,
  parsePrinters,
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

test('routes OCOM jobs through the custom MIME filter and Zebra jobs as raw', () => {
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
