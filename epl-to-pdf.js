'use strict';

const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');

const {
  DEFAULT_MEDIA,
  dotsToMm,
  dotsToPoints,
  normalizeMedia,
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
    hasPrintableContent: false,
  };
}

function absoluteOrigin(state, x, y) {
  return {
    x: state.referenceX + integer(x),
    y: state.referenceY + integer(y),
  };
}

function addClippedPage(doc, width, height) {
  doc.addPage({ size: [width, height], margin: 0 });
  doc.save().rect(0, 0, width, height).clip();
}

function finishClippedPage(doc) {
  doc.restore();
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

function drawText(doc, state, fields, warnings) {
  if (fields.length < 8) {
    warnings.push('Ignored malformed EPL A text command');
    return;
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

  if (
    origin.x >= state.media.widthDots
    || origin.y >= state.media.heightDots
    || origin.x + metrics.widthDots <= 0
    || origin.y + metrics.heightDots <= 0
  ) {
    warnings.push(`Skipped EPL text outside the configured label at ${origin.x},${origin.y}`);
    return;
  }

  doc.save();
  doc.rotate(degrees, { origin: [x, y] });
  if (String(reverse).toUpperCase() === 'R') {
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
  state.hasPrintableContent = true;
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

async function drawBarcode(doc, state, fields, warnings) {
  if (fields.length < 9) {
    warnings.push('Ignored malformed EPL B barcode command');
    return;
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
    return;
  }

  const origin = absoluteOrigin(state, xValue, yValue);
  const availableWidthDots = state.media.widthDots - origin.x;
  const availableHeightDots = state.media.heightDots - origin.y;
  if (availableWidthDots <= 0 || availableHeightDots <= 0) {
    warnings.push(`Skipped EPL barcode outside the configured label at ${origin.x},${origin.y}`);
    return;
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
    const x = dotsToPoints(origin.x, state.media.dpi);
    const y = dotsToPoints(origin.y, state.media.dpi);
    const width = dotsToPoints(availableWidthDots, state.media.dpi);
    const height = dotsToPoints(heightDots, state.media.dpi);
    const degrees = rotationDegrees(rotation);

    doc.save();
    doc.rotate(degrees, { origin: [x, y] });
    doc.image(png, x, y, {
      fit: [width, height],
      align: 'left',
      valign: 'top',
    });
    doc.restore();
    state.hasPrintableContent = true;

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
      ], warnings);
    }
  } catch (error) {
    warnings.push(`Could not render EPL ${symbology} barcode: ${error.message}`);
  }
}

function drawLine(doc, state, fields, warnings) {
  if (fields.length < 4) {
    warnings.push('Ignored malformed EPL LO line command');
    return;
  }
  const [xValue, yValue, widthValue, heightValue] = fields;
  const origin = absoluteOrigin(state, xValue, yValue);
  const width = integer(widthValue);
  const height = integer(heightValue);
  if (width <= 0 || height <= 0) {
    warnings.push('Ignored EPL LO command with a non-positive size');
    return;
  }

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
  state.hasPrintableContent = true;
}

function drawBox(doc, state, fields, warnings) {
  if (fields.length < 5) {
    warnings.push('Ignored malformed EPL X box command');
    return;
  }
  const [xValue, yValue, thicknessValue, rightValue, bottomValue] = fields;
  const origin = absoluteOrigin(state, xValue, yValue);
  const right = state.referenceX + integer(rightValue);
  const bottom = state.referenceY + integer(bottomValue);
  const width = right - origin.x;
  const height = bottom - origin.y;
  if (width <= 0 || height <= 0) {
    warnings.push('Ignored EPL X command with invalid box coordinates');
    return;
  }

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
  state.hasPrintableContent = true;
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
  let state = null;
  let pageOpen = false;
  let pages = 0;
  let copies = 1;

  for (const line of lines) {
    if (/^N$/i.test(line)) {
      if (pageOpen) {
        finishClippedPage(doc);
        warnings.push('Started a new EPL label before the previous label had a P command');
      }
      state = createState(normalizedMedia);
      addClippedPage(doc, pageWidth, pageHeight);
      pageOpen = true;
      pages += 1;
      continue;
    }
    if (!state) continue;

    const printMatch = line.match(/^P(\d+)(?:,\d+)?$/i);
    if (printMatch) {
      state.copies = clamp(integer(printMatch[1], 1), 1, 999);
      copies = Math.max(copies, state.copies);
      finishClippedPage(doc);
      pageOpen = false;
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
      drawText(doc, state, parseCsv(line.slice(1)), warnings);
    } else if (/^B/i.test(line)) {
      await drawBarcode(doc, state, parseCsv(line.slice(1)), warnings);
    } else if (/^LO/i.test(line)) {
      drawLine(doc, state, parseCsv(line.slice(2)), warnings);
    } else if (/^X/i.test(line)) {
      drawBox(doc, state, parseCsv(line.slice(1)), warnings);
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
    finishClippedPage(doc);
    warnings.push('The final EPL label had no P command');
  }
  if (!pages) throw new TypeError('No EPL label format was found');

  doc.end();
  await completed;
  return {
    pdf: Buffer.concat(chunks),
    pages,
    copies,
    media: normalizedMedia,
    warnings: [...new Set(warnings)],
  };
}

module.exports = {
  EPL_FONT_METRICS,
  MAX_EPL_BYTES,
  parseCsv,
  renderEplToPdf,
  tokenizeEpl,
};
