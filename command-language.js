'use strict';

const COMMAND_LANGUAGES = Object.freeze({
  ZPL: 'ZPL',
  EPL: 'EPL',
  UNKNOWN: 'UNKNOWN',
});

const MAX_COMMAND_BYTES = 5 * 1024 * 1024;

function extractCommandData(body = {}) {
  for (const field of ['commands', 'data', 'zpl', 'epl']) {
    const value = body[field];
    if (typeof value === 'string' && value.trim()) {
      if (Buffer.byteLength(value, 'utf8') > MAX_COMMAND_BYTES) {
        throw new RangeError(
          `Print commands exceed the ${MAX_COMMAND_BYTES}-byte input limit`,
        );
      }
      return value;
    }
  }
  throw new TypeError(
    'Print commands are required in the commands, data, zpl, or epl request field',
  );
}

function normalizeCommands(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function detectCommandLanguage(value) {
  const commands = normalizeCommands(value);
  if (!commands) {
    return {
      language: COMMAND_LANGUAGES.UNKNOWN,
      confidence: 'none',
      indicators: [],
    };
  }

  const zplCommands = commands.match(/\^[A-Z0-9@]{2}/gi) || [];
  const hasZplStart = /\^XA(?:\^|\s|$)/i.test(commands);
  const hasZplEnd = /\^XZ(?:\^|\s|$)/i.test(commands);
  if (
    (hasZplStart && zplCommands.length >= 2)
    || (hasZplEnd && zplCommands.length >= 3)
  ) {
    return {
      language: COMMAND_LANGUAGES.ZPL,
      confidence: hasZplStart && hasZplEnd ? 'high' : 'medium',
      indicators: [
        ...(hasZplStart ? ['^XA'] : []),
        ...(hasZplEnd ? ['^XZ'] : []),
        `${zplCommands.length} caret commands`,
      ],
    };
  }

  const lines = commands
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  let eplScore = 0;
  const indicators = [];
  let hasEplField = false;

  for (const line of lines) {
    if (line === 'N') {
      eplScore += 3;
      indicators.push('N');
    } else if (/^q\d+$/i.test(line)) {
      eplScore += 2;
      indicators.push('q width');
    } else if (/^Q\d+(?:,\d+)?$/i.test(line)) {
      eplScore += 2;
      indicators.push('Q length');
    } else if (/^A\d+,\d+,[0-3],[0-5],\d+,\d+,[NRIB],".*"$/i.test(line)) {
      eplScore += 3;
      hasEplField = true;
      indicators.push('A text');
    } else if (/^B\d+,\d+,[0-3],[A-Z0-9]+(?:,[^,]+){3,},".*"$/i.test(line)) {
      eplScore += 3;
      hasEplField = true;
      indicators.push('B barcode');
    } else if (/^P\d+(?:,\d+)?$/i.test(line)) {
      eplScore += 3;
      indicators.push('P print');
    } else if (/^(?:R-?\d+,-?\d+|ZT|ZB|S\d+|D\d+|OD|O[D]?|JF|I8,[A-Z],\d+)$/i.test(line)) {
      eplScore += 1;
      indicators.push('EPL setup');
    }
  }

  const hasEplFrame = lines.includes('N') && lines.some(line => /^P\d+(?:,\d+)?$/i.test(line));
  if ((hasEplFrame && eplScore >= 6) || (hasEplField && eplScore >= 7)) {
    return {
      language: COMMAND_LANGUAGES.EPL,
      confidence: hasEplFrame && hasEplField ? 'high' : 'medium',
      indicators: [...new Set(indicators)],
    };
  }

  return {
    language: COMMAND_LANGUAGES.UNKNOWN,
    confidence: 'low',
    indicators: [],
  };
}

module.exports = {
  COMMAND_LANGUAGES,
  MAX_COMMAND_BYTES,
  detectCommandLanguage,
  extractCommandData,
  normalizeCommands,
};
