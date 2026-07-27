'use strict';

const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');

const DPI = 203;
const MM_PER_INCH = 25.4;
const POINTS_PER_INCH = 72;
const MAX_ZPL_BYTES = 5 * 1024 * 1024;

const DEFAULT_MEDIA = Object.freeze({
  pageSize: 'w288h108',
  widthMm: 101.6,
  heightMm: 38.1,
  widthDots: 812,
  heightDots: 305,
  dpi: DPI,
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

function dotsToPoints(dots, dpi = DPI) {
  return number(dots) * POINTS_PER_INCH / dpi;
}

function dotsToMm(dots, dpi = DPI) {
  return number(dots) * MM_PER_INCH / dpi;
}

function normalizeMedia(media = {}) {
  const dpi = clamp(integer(media.dpi, DPI), 100, 1200);
  const widthMm = number(media.widthMm, DEFAULT_MEDIA.widthMm);
  const heightMm = number(media.heightMm, DEFAULT_MEDIA.heightMm);

  if (widthMm <= 0 || heightMm <= 0) {
    throw new TypeError('The PDF media width and height must be greater than zero');
  }

  return {
    pageSize: String(media.pageSize || DEFAULT_MEDIA.pageSize),
    widthMm,
    heightMm,
    widthDots: integer(media.widthDots, widthMm * dpi / MM_PER_INCH),
    heightDots: integer(media.heightDots, heightMm * dpi / MM_PER_INCH),
    dpi,
  };
}

function decodeHexField(value, indicator = '_') {
  const escaped = indicator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(value).replace(
    new RegExp(`${escaped}([0-9A-Fa-f]{2})`, 'g'),
    (_, hex) => String.fromCharCode(parseInt(hex, 16)),
  );
}

function tokenize(zpl) {
  const commands = [];
  const expression = /([\^~][A-Za-z0-9@]{2})([^\^~]*)/gs;
  let match;
  while ((match = expression.exec(zpl)) !== null) {
    commands.push({
      command: match[1].toUpperCase(),
      args: match[2].replace(/[\r\n]+$/g, ''),
    });
  }
  return commands;
}

function baseState(media) {
  return {
    media,
    x: 0,
    y: 0,
    fieldIsBaseline: false,
    labelHomeX: 0,
    labelHomeY: 0,
    labelShift: 0,
    labelTop: 0,
    font: { name: '0', rotation: 'N', height: 30, width: 30 },
    defaultFont: { name: '0', height: 30, width: 30 },
    defaultRotation: 'N',
    fieldBlock: null,
    barcode: null,
    barcodeDefaults: { module: 2, ratio: 3, height: 100 },
    hexIndicator: null,
    copies: 1,
  };
}

function fontNameForZpl(font) {
  return ['A', 'B', 'D', 'E', 'F', 'G', 'P', 'Q', 'R', 'S', 'T', 'U', 'V'].includes(font)
    ? 'Courier'
    : 'Helvetica';
}

function absoluteOrigin(state) {
  return {
    x: state.labelHomeX + state.labelShift + state.x,
    y: state.labelHomeY + state.labelTop + state.y,
  };
}

function textMetrics(doc, state, scale = 1) {
  const heightDots = clamp(state.font.height * scale, 5, 1000);
  const widthDots = clamp(state.font.width * scale, 1, 1000);
  const fontSize = dotsToPoints(heightDots, state.media.dpi);
  return {
    fontName: fontNameForZpl(state.font.name),
    fontSize,
    heightDots,
    horizontalScaling: clamp(widthDots / heightDots * 100, 10, 1000),
  };
}

function measureText(doc, text, metrics) {
  doc.font(metrics.fontName).fontSize(metrics.fontSize);
  return doc.widthOfString(text, {
    horizontalScaling: metrics.horizontalScaling,
  });
}

function splitLongWord(doc, word, maximumWidth, metrics) {
  const pieces = [];
  let piece = '';
  for (const character of word) {
    if (piece && measureText(doc, piece + character, metrics) > maximumWidth) {
      pieces.push(piece);
      piece = character;
    } else {
      piece += character;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

function wrapText(doc, value, maximumWidth, metrics) {
  const paragraphs = String(value).replace(/\\&/g, '\n').split('\n');
  const lines = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }

    let line = '';
    for (const originalWord of words) {
      const wordParts = measureText(doc, originalWord, metrics) <= maximumWidth
        ? [originalWord]
        : splitLongWord(doc, originalWord, maximumWidth, metrics);

      for (const word of wordParts) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && measureText(doc, candidate, metrics) > maximumWidth) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

function fitFieldBlock(doc, state, value, origin, warnings) {
  const block = state.fieldBlock;
  const availableWidthDots = Math.max(1, state.media.widthDots - origin.x);
  const blockWidthDots = clamp(block.width, 1, availableWidthDots);
  const maximumWidth = dotsToPoints(blockWidthDots, state.media.dpi);
  const availableHeightDots = Math.max(1, state.media.heightDots - origin.y);
  let chosen;

  for (let scale = 1; scale >= 0.25; scale -= 0.05) {
    const metrics = textMetrics(doc, state, scale);
    const lines = wrapText(doc, value, maximumWidth, metrics);
    const spacingDots = block.lineSpacing;
    const lineStepDots = metrics.heightDots + spacingDots;
    const totalHeightDots = lines.length
      ? metrics.heightDots + Math.max(0, lines.length - 1) * lineStepDots
      : 0;

    chosen = { metrics, lines, lineStepDots, totalHeightDots, scale };
    if (lines.length <= block.maxLines && totalHeightDots <= availableHeightDots) break;
  }

  if (chosen.scale < 0.999) {
    warnings.push(
      `Reduced a ^FB text field to ${Math.round(chosen.scale * 100)}% to fit the configured label`,
    );
  }

  if (chosen.lines.length > block.maxLines) {
    chosen.lines = chosen.lines.slice(0, block.maxLines);
    warnings.push(`A ^FB field exceeded its ${block.maxLines}-line limit and was clipped`);
  }

  const heightLimitedLines = Math.max(
    1,
    Math.floor((availableHeightDots + block.lineSpacing) / chosen.lineStepDots),
  );
  if (chosen.lines.length > heightLimitedLines) {
    chosen.lines = chosen.lines.slice(0, heightLimitedLines);
    warnings.push('A ^FB field exceeded the physical label height and was clipped');
  }

  return { ...chosen, blockWidthDots };
}

function drawText(doc, state, value, warnings) {
  const origin = absoluteOrigin(state);
  if (origin.x >= state.media.widthDots || origin.y >= state.media.heightDots) {
    warnings.push(`Skipped text outside the configured label at ${origin.x},${origin.y}`);
    return;
  }

  const fitted = state.fieldBlock
    ? fitFieldBlock(doc, state, value, origin, warnings)
    : {
        metrics: textMetrics(doc, state),
        lines: String(value).replace(/\\&/g, '\n').split('\n'),
        lineStepDots: state.font.height,
        blockWidthDots: state.media.widthDots - origin.x,
      };

  const x = dotsToPoints(origin.x, state.media.dpi);
  let yDots = state.fieldIsBaseline ? origin.y - fitted.metrics.heightDots : origin.y;
  const rotation = state.font.rotation || state.defaultRotation;

  for (const line of fitted.lines) {
    const lineWidth = measureText(doc, line, fitted.metrics);
    const blockWidth = dotsToPoints(fitted.blockWidthDots, state.media.dpi);
    let lineX = x;
    if (state.fieldBlock && state.fieldBlock.alignment === 'C') {
      lineX += Math.max(0, (blockWidth - lineWidth) / 2);
    } else if (state.fieldBlock && state.fieldBlock.alignment === 'R') {
      lineX += Math.max(0, blockWidth - lineWidth);
    }

    let lineY = dotsToPoints(yDots, state.media.dpi);
    doc.save();
    if (rotation !== 'N') {
      const degrees = { R: 90, I: 180, B: 270 }[rotation] || 0;
      doc.rotate(degrees, { origin: [lineX, lineY] });
    }
    doc
      .font(fitted.metrics.fontName)
      .fontSize(fitted.metrics.fontSize)
      .fillColor('black')
      .text(line, lineX, lineY, {
        lineBreak: false,
        horizontalScaling: fitted.metrics.horizontalScaling,
      });
    doc.restore();
    yDots += fitted.lineStepDots;
  }
}

async function drawBarcode(doc, state, value, warnings) {
  const barcode = state.barcode;
  const origin = absoluteOrigin(state);
  const availableWidthDots = Math.max(1, state.media.widthDots - origin.x);
  const availableHeightDots = Math.max(1, state.media.heightDots - origin.y);
  const requestedHeight = clamp(barcode.height, 8, availableHeightDots);
  const bcid = {
    BC: 'code128',
    B3: 'code39',
    BQ: 'qrcode',
  }[barcode.type];

  try {
    const options = {
      bcid,
      text: String(value),
      scale: clamp(integer(state.barcodeDefaults.module, 2), 1, 6),
      includetext: false,
      padding: 0,
      backgroundcolor: 'FFFFFF',
    };
    if (barcode.type !== 'BQ') {
      options.height = Math.max(2, dotsToMm(requestedHeight, state.media.dpi));
    }

    const png = await bwipjs.toBuffer(options);
    const x = dotsToPoints(origin.x, state.media.dpi);
    const y = dotsToPoints(origin.y, state.media.dpi);
    const width = dotsToPoints(availableWidthDots, state.media.dpi);
    const height = dotsToPoints(
      barcode.type === 'BQ' ? Math.min(requestedHeight, availableWidthDots) : requestedHeight,
      state.media.dpi,
    );

    doc.image(png, x, y, {
      fit: [width, height],
      align: 'left',
      valign: 'top',
    });

    if (barcode.readable && barcode.type !== 'BQ') {
      const readableState = {
        ...state,
        x: state.x,
        y: state.y + requestedHeight + 2,
        fieldIsBaseline: false,
        fieldBlock: {
          width: availableWidthDots,
          maxLines: 1,
          lineSpacing: 0,
          alignment: 'C',
        },
        font: { name: '0', rotation: 'N', height: 20, width: 18 },
      };
      drawText(doc, readableState, value, warnings);
    }
  } catch (error) {
    warnings.push(`Could not render ${barcode.type} barcode: ${error.message}`);
  }
}

function drawBox(doc, state, args) {
  const [width, height, thickness = '1', color = 'B', rounding = '0'] = args.split(',');
  const origin = absoluteOrigin(state);
  const x = dotsToPoints(origin.x, state.media.dpi);
  const y = dotsToPoints(origin.y, state.media.dpi);
  const w = dotsToPoints(integer(width), state.media.dpi);
  const h = dotsToPoints(integer(height), state.media.dpi);
  const lineWidth = dotsToPoints(clamp(integer(thickness, 1), 1, 100), state.media.dpi);
  const radius = Math.min(w, h) * clamp(number(rounding), 0, 8) / 16;

  doc.save().lineWidth(lineWidth);
  if (String(color).toUpperCase() === 'W') doc.strokeColor('white');
  else doc.strokeColor('black');
  if (radius > 0) doc.roundedRect(x, y, w, h, radius).stroke();
  else doc.rect(x, y, w, h).stroke();
  doc.restore();
}

function drawCircle(doc, state, args) {
  const [diameter, thickness = '1', color = 'B'] = args.split(',');
  const origin = absoluteOrigin(state);
  const d = dotsToPoints(integer(diameter), state.media.dpi);
  doc.save()
    .lineWidth(dotsToPoints(clamp(integer(thickness, 1), 1, 100), state.media.dpi))
    .strokeColor(String(color).toUpperCase() === 'W' ? 'white' : 'black')
    .circle(
      dotsToPoints(origin.x, state.media.dpi) + d / 2,
      dotsToPoints(origin.y, state.media.dpi) + d / 2,
      d / 2,
    )
    .stroke()
    .restore();
}

function drawUncompressedGraphic(doc, state, args, warnings) {
  const parts = args.split(',');
  if (parts.length < 4) {
    warnings.push('Ignored malformed ^GF graphic');
    return;
  }

  const compression = String(parts[0] || 'A').toUpperCase();
  if (compression !== 'A') {
    warnings.push(`^GF compression ${compression} is not supported by the local PDF renderer`);
    return;
  }

  const rowBytes = integer(parts[3]);
  const hex = parts.slice(4).join('').replace(/\s+/g, '');
  if (rowBytes <= 0 || !/^[0-9A-Fa-f]*$/.test(hex)) {
    warnings.push('Ignored malformed ^GFA bitmap data');
    return;
  }

  const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
  const rows = Math.floor(bytes.length / rowBytes);
  const origin = absoluteOrigin(state);
  const dot = dotsToPoints(1, state.media.dpi);
  doc.save().fillColor('black');

  for (let row = 0; row < rows; row++) {
    let runStart = -1;
    const width = rowBytes * 8;
    for (let column = 0; column <= width; column++) {
      const black = column < width
        && (bytes[row * rowBytes + Math.floor(column / 8)] & (0x80 >> (column % 8)));
      if (black && runStart < 0) runStart = column;
      if (!black && runStart >= 0) {
        doc.rect(
          dotsToPoints(origin.x + runStart, state.media.dpi),
          dotsToPoints(origin.y + row, state.media.dpi),
          (column - runStart) * dot,
          dot,
        ).fill();
        runStart = -1;
      }
    }
  }
  doc.restore();
}

async function renderZplToPdf(zpl, media = DEFAULT_MEDIA) {
  if (typeof zpl !== 'string' || !zpl.includes('^XA')) {
    throw new TypeError('ZPL must be a string containing at least one ^XA label format');
  }
  if (Buffer.byteLength(zpl, 'utf8') > MAX_ZPL_BYTES) {
    throw new RangeError(`ZPL exceeds the ${MAX_ZPL_BYTES}-byte renderer limit`);
  }

  const normalizedMedia = normalizeMedia(media);
  const pageWidth = normalizedMedia.widthMm * POINTS_PER_INCH / MM_PER_INCH;
  const pageHeight = normalizedMedia.heightMm * POINTS_PER_INCH / MM_PER_INCH;
  const doc = new PDFDocument({
    autoFirstPage: false,
    compress: false,
    info: {
      Title: 'ZPLExpress label',
      Creator: 'ZPLExpress local ZPL-to-PDF renderer',
    },
  });
  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    doc.on('data', chunk => chunks.push(chunk));
    doc.once('end', resolve);
    doc.once('error', reject);
  });

  const warnings = [];
  const commands = tokenize(zpl);
  let state = null;
  let pages = 0;
  let copies = 1;

  for (const token of commands) {
    const command = token.command;
    const args = token.args;

    if (command === '^XA') {
      state = baseState(normalizedMedia);
      doc.addPage({ size: [pageWidth, pageHeight], margin: 0 });
      pages += 1;
      continue;
    }
    if (!state) continue;
    if (command === '^XZ') {
      copies = Math.max(copies, state.copies);
      state = null;
      continue;
    }

    if (command === '^PW' || command === '^LL') {
      // The physical CUPS media is authoritative. These logical dimensions
      // still use the same 203-dpi coordinate system, but cannot change feed.
      continue;
    }
    if (command === '^LH') {
      const [x, y] = args.split(',');
      state.labelHomeX = integer(x);
      state.labelHomeY = integer(y);
    } else if (command === '^LS') {
      state.labelShift = integer(args);
    } else if (command === '^LT') {
      state.labelTop = integer(args);
    } else if (command === '^FO' || command === '^FT') {
      const [x, y] = args.split(',');
      state.x = integer(x);
      state.y = integer(y);
      state.fieldIsBaseline = command === '^FT';
      state.fieldBlock = null;
      state.barcode = null;
      state.hexIndicator = null;
    } else if (command === '^FW') {
      state.defaultRotation = String(args[0] || 'N').toUpperCase();
      state.font.rotation = state.defaultRotation;
    } else if (command === '^CF') {
      const [name = '0', height, width] = args.split(',');
      state.defaultFont = {
        name: name.toUpperCase(),
        height: clamp(integer(height, state.defaultFont.height), 5, 1000),
        width: clamp(integer(width, height || state.defaultFont.width), 1, 1000),
      };
      state.font = { ...state.defaultFont, rotation: state.defaultRotation };
    } else if (/^\^A[A-Z0-9]$/.test(command)) {
      const [rotation = state.defaultRotation, height, width] = args.split(',');
      state.font = {
        name: command[2],
        rotation: String(rotation || state.defaultRotation).toUpperCase(),
        height: clamp(integer(height, state.defaultFont.height), 5, 1000),
        width: clamp(integer(width, height || state.defaultFont.width), 1, 1000),
      };
    } else if (command === '^FB') {
      const [width, maxLines = '1', lineSpacing = '0', alignment = 'L'] = args.split(',');
      state.fieldBlock = {
        width: clamp(integer(width, normalizedMedia.widthDots - state.x), 1, 10000),
        maxLines: clamp(integer(maxLines, 1), 1, 1000),
        lineSpacing: integer(lineSpacing),
        alignment: String(alignment || 'L').toUpperCase(),
      };
    } else if (command === '^FH') {
      state.hexIndicator = args[0] || '_';
    } else if (command === '^BY') {
      const [module = '2', ratio = '3', height = '100'] = args.split(',');
      state.barcodeDefaults = {
        module: clamp(integer(module, 2), 1, 10),
        ratio: clamp(number(ratio, 3), 2, 3),
        height: clamp(integer(height, 100), 1, 10000),
      };
    } else if (command === '^BC' || command === '^B3') {
      const [rotation = 'N', height, readable = 'Y'] = args.split(',');
      state.barcode = {
        type: command.slice(1),
        rotation: String(rotation || 'N').toUpperCase(),
        height: clamp(integer(height, state.barcodeDefaults.height), 8, 10000),
        readable: String(readable || 'Y').toUpperCase() === 'Y',
      };
    } else if (command === '^BQ') {
      const [, model = '2', magnification = '2'] = args.split(',');
      state.barcode = {
        type: 'BQ',
        model: clamp(integer(model, 2), 1, 2),
        height: clamp(integer(magnification, 2) * 29, 21, 1000),
        readable: false,
      };
    } else if (command === '^GB') {
      drawBox(doc, state, args);
    } else if (command === '^GC') {
      drawCircle(doc, state, args);
    } else if (command === '^GF') {
      drawUncompressedGraphic(doc, state, args, warnings);
    } else if (command === '^PQ') {
      state.copies = clamp(integer(args.split(',')[0], 1), 1, 999);
    } else if (command === '^FD') {
      const value = state.hexIndicator ? decodeHexField(args, state.hexIndicator) : args;
      if (state.barcode) await drawBarcode(doc, state, value, warnings);
      else drawText(doc, state, value, warnings);
    } else if (command === '^FS') {
      state.fieldBlock = null;
      state.barcode = null;
      state.hexIndicator = null;
    }
  }

  if (!pages) {
    throw new TypeError('No complete ZPL label format was found');
  }

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
  DEFAULT_MEDIA,
  DPI,
  decodeHexField,
  dotsToMm,
  dotsToPoints,
  normalizeMedia,
  renderZplToPdf,
  tokenize,
  wrapText,
};
