'use strict';

const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');

const {
  DEFAULT_MEDIA,
  addClippedLabelPage,
  dotsToMm,
  dotsToPoints,
  finishClippedLabelPage,
  intersectsLabel,
  normalizeMedia,
  rotateFieldOrigin,
} = require('./zpl-to-pdf');

const MAX_EPL_BYTES = 5 * 1024 * 1024;
const POINTS_PER_INCH = 72;
const MM_PER_INCH = 25.4;

const EPL_FONT_METRICS = Object.freeze({
  1: { width: 8, height: 12 },
  2: { width: 10, height: 16 },
  3: { width: 12, height: 20 },
  4: { width: 14, height: 24 },
  5: { width: 32, height: 48 },
});

function number(value, fallback = 0) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integer(value, fallback = 0) {
  return Math.round(number(value, fallback));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function parseCsv(value) {
  const fields = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (index > 0 && value[index - 1] === '\\') {
        field = `${field.slice(0, -1)}"`;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(field.trim());
      field = '';
    } else {
      field += character;
    }
  }

  if (quoted) throw new TypeError('Malformed EPL command: unterminated quoted value');
  fields.push(field.trim());
  return fields;
}

function tokenizeEpl(epl) {
  return String(epl)
    .replace(/^\uFEFF/, '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function createState(media) {
  return {
    media,
    referenceX: 0,
    referenceY: 0,
    direction: 'ZT',
    copies: 1,
  };
}

function absoluteOrigin(state, x, y) {
  return {
    x: state.referenceX + integer(x),
    y: state.referenceY + integer(y),
  };
}

function findEplContentOrigins(lines) {
  const origins = [];
  let state = null;
  let current = null;

  function record(fields) {
    if (!state || !current || fields.length < 2) return;
    current.x = Math.min(current.x, state.referenceX + integer(fields[0]));
    current.y = Math.min(current.y, state.referenceY + integer(fields[1]));
  }

  for (const line of lines) {
    if (/^N$/i.test(line)) {
      state = createState(DEFAULT_MEDIA);
      current = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
      origins.push(current);
      continue;
    }
    if (!state) continue;
    if (/^P\d+(?:,\d+)?$/i.test(line)) {
      state = null;
      current = null;
      continue;
    }
    if (/^R-?\d+,-?\d+$/i.test(line)) {
      const [x, y] = line.slice(1).split(',');
      state.referenceX = integer(x);
      state.referenceY = integer(y);
    } else if (/^LO/i.test(line)) {
      record(parseCsv(line.slice(2)));
    } else if (/^[ABX]/i.test(line)) {
      record(parseCsv(line.slice(1)));
    }
  }

  return origins.map(origin => ({
    x: Number.isFinite(origin.x) ? origin.x : 0,
    y: Number.isFinite(origin.y) ? origin.y : 0,
  }));
}

function textMetrics(font, horizontalMultiplier, verticalMultiplier, media) {
  const base = EPL_FONT_METRICS[String(font)] || EPL_FONT_METRICS[3];
  const widthDots = base.width * clamp(integer(horizontalMultiplier, 1), 1, 8);
  const heightDots = base.height * clamp(integer(verticalMultiplier, 1), 1, 9);
  const fontSize = dotsToPoints(heightDots, media.dpi);

  // Courier is 0.6 em wide. Scale it to match the fixed EPL bitmap-font cell.
  return {
    widthDots,
    heightDots,
    fontSize,
    horizontalScaling: clamp(widthDots / (heightDots * 0.6) * 100, 10, 1000),
  };
}

function rotationDegrees(value) {
  return {
    0: 0,
    1: 90,
    2: 180,
    3: 270,
  }[integer(value)] ?? 0;
}

function eplPrintQuantity(command, maximum = 999) {
  const match = String(command).trim().match(/^P(\d+)(?:,(\d+))?$/i);
  if (!match) return null;

  const sets = BigInt(match[1]);
  const copiesPerLabel = match[2] === undefined ? 1n : BigInt(match[2]);
  const limit = BigInt(maximum);
  if (sets < 1n || copiesPerLabel < 1n) {
    throw new RangeError('EPL print quantities must be greater than zero');
  }
  if (sets > limit || copiesPerLabel > limit || sets * copiesPerLabel > limit) {
    throw new RangeError(
      `The EPL command stream requests more than ${maximum} labels`,
    );
  }
  return Number(sets * copiesPerLabel);
}

function drawText(doc, state, fields, warnings, ensurePage) {
  if (fields.length < 8) {
    warnings.push('Ignored malformed EPL A text command');
    return false;
  }

  const [xValue, yValue, rotation, font, horizontal, vertical, reverse, ...textParts] =
    fields;
  const value = textParts.join(',');
  const origin = absoluteOrigin(state, xValue, yValue);
  const metrics = textMetrics(font, horizontal, vertical, state.media);
  const x = dotsToPoints(origin.x, state.media.dpi);
  const y = dotsToPoints(origin.y, state.media.dpi);
  const degrees = rotationDegrees(rotation);
  const textWidth = dotsToPoints(metrics.widthDots * value.length, state.media.dpi);
  const textHeight = dotsToPoints(metrics.heightDots, state.media.dpi);
  const reversed = String(reverse).toUpperCase() === 'R';
  const rotated = degrees === 90 || degrees === 270;
  const widthDots = metrics.widthDots * value.length;
  const heightDots = metrics.heightDots;

  if (!intersectsLabel(
    origin,
    rotated ? heightDots : widthDots,
    rotated ? widthDots : heightDots,
    state.media,
  )) {
    warnings.push(`Skipped EPL text outside the configured label at ${origin.x},${origin.y}`);
    return false;
  }
  if (!reversed && !value.trim().length) {
    warnings.push('Skipped an EPL text field containing no printable characters');
    return false;
  }

  ensurePage();
  doc.save();
  rotateFieldOrigin(doc, degrees, x, y, textWidth, textHeight);
  if (reversed) {
    doc.fillColor('black').rect(x, y, textWidth, textHeight).fill();
    doc.fillColor('white');
  } else {
    doc.fillColor('black');
  }
  doc
    .font('Courier')
    .fontSize(metrics.fontSize)
    .text(value, x, y, {
      lineBreak: false,
      horizontalScaling: metrics.horizontalScaling,
    });
  doc.restore();
  return true;
}

function barcodeType(value) {
  const type = String(value || '').toUpperCase();
  if (['1', '1A', '1B', '1C'].includes(type)) return 'code128';
  if (type === '3' || type === '3C') return 'code39';
  if (['2', '2C', '2D', '2G'].includes(type)) return 'interleaved2of5';
  if (type === 'E30') return 'ean13';
  if (type === 'E80') return 'ean8';
  if (type === 'UA0') return 'upca';
  if (type === 'K') return 'rationalizedCodabar';
  return null;
}

async function drawBarcode(doc, state, fields, warnings, ensurePage) {
  if (fields.length < 9) {
    warnings.push('Ignored malformed EPL B barcode command');
    return false;
  }

  const [
    xValue,
    yValue,
    rotation,
    symbology,
    narrowValue,
    ,
    heightValue,
    readableValue,
    ...dataParts
  ] = fields;
  const value = dataParts.join(',');
  const bcid = barcodeType(symbology);
  if (!bcid) {
    warnings.push(`EPL barcode type ${symbology || '(empty)'} is not supported`);
    return false;
  }

  const origin = absoluteOrigin(state, xValue, yValue);
  const availableWidthDots = state.media.widthDots - origin.x;
  const availableHeightDots = state.media.heightDots - origin.y;
  if (availableWidthDots <= 0 || availableHeightDots <= 0) {
    warnings.push(`Skipped EPL barcode outside the configured label at ${origin.x},${origin.y}`);
    return false;
  }

  const heightDots = clamp(integer(heightValue, 80), 8, availableHeightDots);
  const scale = clamp(integer(narrowValue, 2), 1, 6);

  try {
    const png = await bwipjs.toBuffer({
      bcid,
      text: value,
      scale,
      height: Math.max(2, dotsToMm(heightDots, state.media.dpi)),
      includetext: false,
      padding: 0,
      backgroundcolor: 'FFFFFF',
    });
    ensurePage();
    const x = dotsToPoints(origin.x, state.media.dpi);
    const y = dotsToPoints(origin.y, state.media.dpi);
    const width = dotsToPoints(availableWidthDots, state.media.dpi);
    const height = dotsToPoints(heightDots, state.media.dpi);
    const degrees = rotationDegrees(rotation);

    doc.save();
    rotateFieldOrigin(doc, degrees, x, y, width, height);
    doc.image(png, x, y, {
      fit: [width, height],
      align: 'left',
      valign: 'top',
    });
    doc.restore();

    if (String(readableValue).toUpperCase() !== 'N') {
      drawText(doc, state, [
        String(origin.x - state.referenceX),
        String(origin.y - state.referenceY + heightDots + 2),
        rotation,
        '2',
        '1',
        '1',
        'N',
        value,
      ], warnings, ensurePage);
    }
    return true;
  } catch (error) {
    warnings.push(`Could not render EPL ${symbology} barcode: ${error.message}`);
    return false;
  }
}

function drawLine(doc, state, fields, warnings, ensurePage) {
  if (fields.length < 4) {
    warnings.push('Ignored malformed EPL LO line command');
    return false;
  }
  const [xValue, yValue, widthValue, heightValue] = fields;
  const origin = absoluteOrigin(state, xValue, yValue);
  const width = integer(widthValue);
  const height = integer(heightValue);
  if (width <= 0 || height <= 0) {
    warnings.push('Ignored EPL LO command with a non-positive size');
    return false;
  }
  if (!intersectsLabel(origin, width, height, state.media)) {
    warnings.push(`Skipped an EPL line outside the configured label at ${origin.x},${origin.y}`);
    return false;
  }

  ensurePage();
  doc
    .save()
    .fillColor('black')
    .rect(
      dotsToPoints(origin.x, state.media.dpi),
      dotsToPoints(origin.y, state.media.dpi),
      dotsToPoints(width, state.media.dpi),
      dotsToPoints(height, state.media.dpi),
    )
    .fill()
    .restore();
  return true;
}

function drawBox(doc, state, fields, warnings, ensurePage) {
  if (fields.length < 5) {
    warnings.push('Ignored malformed EPL X box command');
    return false;
  }
  const [xValue, yValue, thicknessValue, rightValue, bottomValue] = fields;
  const origin = absoluteOrigin(state, xValue, yValue);
  const right = state.referenceX + integer(rightValue);
  const bottom = state.referenceY + integer(bottomValue);
  const width = right - origin.x;
  const height = bottom - origin.y;
  if (width <= 0 || height <= 0) {
    warnings.push('Ignored EPL X command with invalid box coordinates');
    return false;
  }
  if (!intersectsLabel(origin, width, height, state.media)) {
    warnings.push(`Skipped an EPL box outside the configured label at ${origin.x},${origin.y}`);
    return false;
  }

  ensurePage();
  doc
    .save()
    .strokeColor('black')
    .lineWidth(dotsToPoints(clamp(integer(thicknessValue, 1), 1, 100), state.media.dpi))
    .rect(
      dotsToPoints(origin.x, state.media.dpi),
      dotsToPoints(origin.y, state.media.dpi),
      dotsToPoints(width, state.media.dpi),
      dotsToPoints(height, state.media.dpi),
    )
    .stroke()
    .restore();
  return true;
}

async function renderEplToPdf(epl, media = DEFAULT_MEDIA) {
  if (typeof epl !== 'string') {
    throw new TypeError('EPL must be supplied as a string');
  }
  if (Buffer.byteLength(epl, 'utf8') > MAX_EPL_BYTES) {
    throw new RangeError(`EPL exceeds the ${MAX_EPL_BYTES}-byte renderer limit`);
  }

  const lines = tokenizeEpl(epl);
  if (
    !lines.some(line => /^N$/i.test(line))
    || !lines.some(line => /^P\d+(?:,\d+)?$/i.test(line))
  ) {
    throw new TypeError('EPL must contain at least one N ... P label format');
  }

  const normalizedMedia = normalizeMedia(media);
  const pageWidth = normalizedMedia.widthMm * POINTS_PER_INCH / MM_PER_INCH;
  const pageHeight = normalizedMedia.heightMm * POINTS_PER_INCH / MM_PER_INCH;
  const doc = new PDFDocument({
    autoFirstPage: false,
    compress: false,
    info: {
      Title: 'ZPLExpress EPL label',
      Creator: 'ZPLExpress local EPL-to-PDF renderer',
    },
  });
  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.once('end', resolve);
    doc.once('error', reject);
  });

  const warnings = [];
  const contentOrigins = findEplContentOrigins(lines);
  let state = null;
  let pageOpen = false;
  let pages = 0;
  let copies = 1;
  let emptyFormats = 0;

  // An EPL format only earns a page once it draws something. Setup-only
  // formats are common in label streams, and giving one a page makes the
  // printer feed a blank label.
  const openPage = () => {
    if (pageOpen) return true;
    addClippedLabelPage(doc, pageWidth, pageHeight);
    pageOpen = true;
    pages += 1;
    return true;
  };

  for (const line of lines) {
    if (/^N$/i.test(line)) {
      if (pageOpen) {
        finishClippedLabelPage(doc);
        pageOpen = false;
        warnings.push('Started a new EPL label before the previous label had a P command');
      }
      // Preserve the EPL reference and field coordinates. contentOrigins is
      // diagnostic only; subtracting it removes intentional safety margins.
      state = createState(normalizedMedia);
      continue;
    }
    if (!state) continue;

    const printQuantity = eplPrintQuantity(line);
    if (printQuantity !== null) {
      state.copies = printQuantity;
      if (pageOpen) {
        copies = Math.max(copies, state.copies);
        finishClippedLabelPage(doc);
        pageOpen = false;
      } else {
        emptyFormats += 1;
      }
      state = null;
      continue;
    }

    if (/^q\d+$/i.test(line) || /^Q\d+(?:,\d+)?$/i.test(line)) {
      // CUPS PageSize remains authoritative so an EPL logical size cannot
      // accidentally feed into a second physical label.
      continue;
    }
    if (/^R-?\d+,-?\d+$/i.test(line)) {
      const [x, y] = line.slice(1).split(',');
      state.referenceX = integer(x);
      state.referenceY = integer(y);
    } else if (/^Z[TB]$/i.test(line)) {
      state.direction = line.toUpperCase();
      if (state.direction === 'ZB') {
        warnings.push('EPL ZB bottom-up feed direction is approximated on fixed PDF media');
      }
    } else if (/^A/i.test(line)) {
      drawText(doc, state, parseCsv(line.slice(1)), warnings, openPage);
    } else if (/^B/i.test(line)) {
      await drawBarcode(doc, state, parseCsv(line.slice(1)), warnings, openPage);
    } else if (/^LO/i.test(line)) {
      drawLine(doc, state, parseCsv(line.slice(2)), warnings, openPage);
    } else if (/^X/i.test(line)) {
      drawBox(doc, state, parseCsv(line.slice(1)), warnings, openPage);
    } else if (
      /^(?:S\d+|D\d+|OD|O|JF|I8,[A-Z],\d+)$/i.test(line)
    ) {
      // Device speed, density, orientation, flash, and character-set setup do
      // not alter the geometry of the local PDF representation.
    } else {
      warnings.push(`Unsupported EPL command was ignored: ${line.slice(0, 60)}`);
    }
  }

  if (pageOpen) {
    finishClippedLabelPage(doc);
    warnings.push('The final EPL label had no P command');
  }
  if (emptyFormats) {
    warnings.push(
      `Skipped ${emptyFormats} empty EPL label format(s) that would have fed a blank label`,
    );
  }
  if (!pages) throw new TypeError('No EPL label format contained anything to print');

  doc.end();
  await completed;
  return {
    pdf: Buffer.concat(chunks),
    pages,
    copies,
    media: normalizedMedia,
    contentOrigins,
    warnings: [...new Set(warnings)],
  };
}

module.exports = {
  EPL_FONT_METRICS,
  MAX_EPL_BYTES,
  eplPrintQuantity,
  findEplContentOrigins,
  parseCsv,
  renderEplToPdf,
  tokenizeEpl,
};
