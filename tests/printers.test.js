const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_MEDIA,
  OCOM_EPL_FORMAT,
  OCOM_ZPL_FORMAT,
  buildPrintArgs,
  detectPrinterModel,
  getPrinterMedia,
  getPrinterStatus,
  isOcomPrinter,
  parseConnectedDeviceUris,
  parseDeviceUri,
  parseLpOptions,
  parseMarkedLpOption,
  parsePageSize,
  parsePrinters,
  submitCommands,
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

test('routes OCOM through language MIME filters and ARGOX/ZEBRA as raw commands', () => {
  assert.deepEqual(buildPrintArgs('OCOM_Ubuntu_Driver', 'ZPL'), [
    '-d',
    'OCOM_Ubuntu_Driver',
    '-n',
    '1',
    '-t',
    'ZPLExpress label',
    '-o',
    `document-format=${OCOM_ZPL_FORMAT}`,
    '-',
  ]);

  assert.deepEqual(buildPrintArgs('OCOM_Ubuntu_Driver', 'EPL'), [
    '-d',
    'OCOM_Ubuntu_Driver',
    '-n',
    '1',
    '-t',
    'ZPLExpress label',
    '-o',
    `document-format=${OCOM_EPL_FORMAT}`,
    '-',
  ]);

  assert.deepEqual(buildPrintArgs('Zebra_GK420d'), [
    '-d',
    'Zebra_GK420d',
    '-o',
    'raw',
  ]);

  assert.deepEqual(buildPrintArgs('Argox_OS-2140'), [
    '-d',
    'Argox_OS-2140',
    '-o',
    'raw',
  ]);

  assert.throws(
    () => buildPrintArgs('OCOM_Ubuntu_Driver', 'UNKNOWN'),
    /must be ZPL or EPL/,
  );
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

  assert.deepEqual(parsePageSize('OCOM102x36'), {
    pageSize: 'OCOM102x36',
    widthMm: 102,
    heightMm: 36,
    widthDots: 815,
    heightDots: 288,
    dpi: 203,
  });

  assert.deepEqual(parsePageSize('ocom102x36'), {
    pageSize: 'ocom102x36',
    widthMm: 102,
    heightMm: 36,
    widthDots: 815,
    heightDots: 288,
    dpi: 203,
  });

  const custom = parsePageSize('Custom.50.8x25.4mm');
  assert.equal(custom.widthMm, 50.8);
  assert.equal(custom.heightMm, 25.4);
  assert.equal(custom.widthDots, 406);
  assert.equal(custom.heightDots, 203);

  assert.deepEqual(parsePageSize('Custom.102x36mm'), {
    pageSize: 'Custom.102x36mm',
    widthMm: 102,
    heightMm: 36,
    widthDots: 815,
    heightDots: 288,
    dpi: 203,
  });
});

test('uses 102 x 36 mm as the fallback media', () => {
  assert.equal(DEFAULT_MEDIA.pageSize, 'OCOM102x36');
  assert.equal(DEFAULT_MEDIA.widthDots, 815);
  assert.equal(DEFAULT_MEDIA.heightDots, 288);
  assert.equal(DEFAULT_MEDIA.widthMm, 102);
  assert.equal(DEFAULT_MEDIA.heightMm, 36);
});

test('reads the active PageSize from detailed CUPS PPD options', () => {
  const options = [
    'PageSize/Media Size: w288h108 *w288h432 Custom.WIDTHxHEIGHT',
    'Resolution/Resolution: *203dpi',
  ].join('\n');

  assert.equal(parseMarkedLpOption(options), 'w288h432');
  assert.equal(
    parseMarkedLpOption('media/Media Size: 4x1.5 *Custom.80x30mm'),
    'Custom.80x30mm',
  );
  assert.equal(parseMarkedLpOption('Resolution/Resolution: *203dpi'), null);
});

test('falls back to detailed CUPS options when compact output omits PageSize', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zplexpress-media-test-'));
  const oldPath = process.env.PATH;
  const lpoptions = path.join(tempDir, 'lpoptions');
  fs.writeFileSync(lpoptions, [
    '#!/bin/sh',
    'if [ "$3" = "-l" ]; then',
    '  printf "%s\\n" "PageSize/Media Size: *w288h108 w288h432 Custom.WIDTHxHEIGHT"',
    'else',
    '  printf "%s\\n" "copies=1 ZPLFontMode=NoOversize"',
    'fi',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${tempDir}:${oldPath}`;

  try {
    const media = await getPrinterMedia('OCBP-T4201-2');
    assert.equal(media.pageSize, 'w288h108');
    assert.equal(media.source, 'cups-detailed');
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('keeps a printer name as one lp argument instead of executing a shell', () => {
  const unsafeLookingName = 'printer; touch /tmp/should-not-exist';
  const args = buildPrintArgs(unsafeLookingName, 'ZPL');

  assert.equal(args[1], unsafeLookingName);
  assert.deepEqual(args.slice(2, 4), ['-n', '1']);
  assert.equal(args.length, 9);
});

test('detects a plugged OCOM device and submits unchanged ZPL through the driver', async () => {
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

    const commands = '\n^XA^FO20,20^FDJOHN DOE^FS^XZ\r\n';
    const result = await submitCommands(
      'OCOM_Ubuntu_Driver',
      commands,
      'ZPL',
    );
    assert.equal(result.jobId, 'OCOM_Ubuntu_Driver-42');
    assert.ok(
      fs.readFileSync(argsFile, 'utf8').includes(`document-format=${OCOM_ZPL_FORMAT}`),
    );
    assert.equal(fs.readFileSync(inputFile, 'utf8'), commands);

    const rawEpl = '\nN\nA10,10,0,3,1,1,N,"RAW EPL"\nP1\n';
    await submitCommands('Argox_OS-2140', rawEpl);
    assert.match(fs.readFileSync(argsFile, 'utf8'), /(?:^|\n)raw(?:\n|$)/);
    assert.doesNotMatch(fs.readFileSync(argsFile, 'utf8'), /document-format=/);
    assert.equal(fs.readFileSync(inputFile, 'utf8'), rawEpl);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.ZPL_TEST_ARGS;
    delete process.env.ZPL_TEST_INPUT;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
