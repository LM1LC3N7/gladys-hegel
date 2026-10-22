// -----------------------------------------------------------------------------
// The Hegel IP control protocol, as hegel-ip-client (MIT, see
// THIRD_PARTY_NOTICES.md) speaks it: a command is `-<letter>.<value>` ended by
// a carriage return; `?` as the value asks it (`-p.?`); the amplifier answers
// `-<letter>.<value>` and also writes such a line by itself on every change
// (front panel, remote). `-p` power (0/1), `-v` volume (0..100), `-m` mute
// (0/1), `-i` input (1..). An error is answered `-e.<n>`.
//
// Everything here is pure and bounded: lines are cut at LIMITS.line, every
// line is matched once by an anchored expression, values are parsed strictly,
// and only well-formed values of the known letters are ever written.
// -----------------------------------------------------------------------------

import { INPUTS, LIMITS } from '../constants.js';

export const KEYS = Object.freeze({
  POWER: 'p',
  VOLUME: 'v',
  MUTE: 'm',
  INPUT: 'i',
});

/** The key of the error answer (`-e.<n>`): never sent. */
export const ERROR_KEY = 'e';

/** The values that may be written, per key. */
const VALUES = Object.freeze({
  p: /^[01]$/,
  m: /^[01]$/,
  v: /^(?:100|[1-9]?\d)$/,
  i: /^(?:[1-9]|1\d|20)$/,
});

/** An input number that may be written into a command (`1` .. `20`). */
export const isInputValue = (value) => typeof value === 'string' && VALUES.i.test(value);

/** The bytes of one command: `-<key>.?` or `-<key>.<value>`, then `\r`. */
export function encode(key, operator, value) {
  if (!Object.hasOwn(VALUES, key)) {
    throw new Error(`Unknown Hegel key "${String(key).slice(0, 8)}"`);
  }
  if (operator === '?') {
    return Buffer.from(`-${key}.?\r`, 'latin1');
  }
  if (operator === '=' && typeof value === 'string' && VALUES[key].test(value)) {
    return Buffer.from(`-${key}.${value}\r`, 'latin1');
  }
  throw new Error(`Invalid Hegel command for -${key}`);
}

const LINE = /^-([a-z])\.([0-9a-z~?]{1,4})$/i;

/** One line of the amplifier -> `{ key, value }` (key lowercased), or undefined. */
export function parseLine(text) {
  const match = LINE.exec(String(text).trim());
  if (!match) {
    return undefined;
  }
  return { key: match[1].toLowerCase(), value: match[2] };
}

export function parseFlag(value) {
  if (value === '1') {
    return true;
  }
  if (value === '0') {
    return false;
  }
  return undefined;
}

/** A volume 0..100 (digits only), or undefined. */
export function parseVolume(value) {
  return typeof value === 'string' && VALUES.v.test(value) ? Number(value) : undefined;
}

/** An input number as a string ('1' .. '20'), or undefined. */
export function parseInput(value) {
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value)) {
    return undefined;
  }
  const n = Number(value);
  return n >= INPUTS.min && n <= INPUTS.max ? String(n) : undefined;
}

/**
 * Whether a line of `key` answering a `-key.sent` command confirms it: the
 * value asked, nothing else. Any other value (a late answer, a pushed change)
 * is a state, not a confirmation.
 */
export function confirmsSet(key, sent, answered) {
  switch (key) {
    case KEYS.POWER:
    case KEYS.MUTE: {
      const asked = parseFlag(sent);
      return asked !== undefined && parseFlag(answered) === asked;
    }
    case KEYS.VOLUME: {
      const asked = parseVolume(sent);
      return asked !== undefined && parseVolume(answered) === asked;
    }
    case KEYS.INPUT: {
      const asked = parseInput(sent);
      return asked !== undefined && parseInput(answered) === asked;
    }
    default:
      return false;
  }
}

// Control characters (C0, DEL, C1) and bidirectional overrides.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** A display text (input label): cleaned, trimmed, cut; undefined when empty. */
export function cleanText(value, max = LIMITS.name) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.replace(UNSAFE, '').trim().slice(0, max).trim();
  return text === '' ? undefined : text;
}

/**
 * Applies one parsed line to a state object (a copy is returned when
 * something changed, the same object otherwise). Only the known keys are
 * read; an unreadable value makes that state unknown.
 */
export function applyLine(state, { key, value }) {
  const next = { ...state };
  switch (key) {
    case KEYS.POWER:
      next.power = parseFlag(value);
      break;
    case KEYS.MUTE:
      next.mute = parseFlag(value);
      break;
    case KEYS.VOLUME:
      next.volume = parseVolume(value);
      break;
    case KEYS.INPUT:
      next.input = parseInput(value);
      break;
    default:
      return state;
  }
  const changed = Object.keys(next).some((k) => next[k] !== state[k]);
  return changed ? next : state;
}

/**
 * Splits the text of the amplifier into lines (`\r` or `\n`). A line longer
 * than `max` is dropped whole, up to its end, never kept growing.
 */
export class LineSplitter {
  constructor(max = LIMITS.line) {
    this.max = max;
    this.buffer = '';
    this.overflow = false;
  }

  /** @returns {string[]} the complete, non-empty lines */
  push(text) {
    const lines = [];
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c === 10 || c === 13) {
        this.add(text.slice(start, i));
        if (!this.overflow && this.buffer.trim() !== '') {
          lines.push(this.buffer);
        }
        this.buffer = '';
        this.overflow = false;
        start = i + 1;
      }
    }
    this.add(text.slice(start));
    return lines;
  }

  add(part) {
    if (this.overflow) {
      return;
    }
    if (this.buffer.length + part.length > this.max) {
      this.overflow = true;
      this.buffer = '';
      return;
    }
    this.buffer += part;
  }
}
