// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, LIMITS, MAX_VOLUME } from './constants.js';
import { cleanText, isInputValue } from './hegel/protocol.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  max_volume: MAX_VOLUME.default,
  input_names: '',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address of an amplifier typed by the user: an IPv4 address or a host
 * name, with an optional port (a pasted `tcp://` URL is reduced to its host
 * and port).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^tcp:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/**
 * The platform id of the amplifier at an address (the protocol gives no
 * serial number): the host, plus `_<port>` when not 50001. `_` never appears
 * in a host name, so two addresses never share an id.
 */
export const addressId = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}_${port}`);

/** The volume cap: an integer 1..100; anything unreadable gives the default (40). */
export function parseMaxVolume(raw) {
  const value = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
  if (raw === null || raw === undefined || typeof raw === 'boolean' || !Number.isFinite(value)) {
    return MAX_VOLUME.default;
  }
  return Math.min(MAX_VOLUME.max, Math.max(MAX_VOLUME.min, Math.round(value)));
}

/**
 * Names given to the inputs (the protocol does not tell them):
 * `1=Balanced, 2=Analog 1, 9=Network` -> [{ value: '1', label: 'Balanced' }, ...].
 */
export function parseInputNames(raw) {
  const options = [];
  const invalid = [];
  for (const entry of String(raw ?? '')
    .split(/[,;\n]+/)
    .map((e) => e.trim())
    .filter((e) => e !== '')) {
    const match = /^([^=]{1,8})=(.{1,64})$/.exec(entry);
    const value = match?.[1].trim();
    const label = cleanText(match?.[2]);
    if (!isInputValue(value) || !label) {
      invalid.push(entry.slice(0, 100));
    } else if (!options.some((o) => o.value === value) && options.length < LIMITS.inputs) {
      options.push({ value, label });
    }
  }
  return { options, invalid };
}

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)),
  };
  const addresses = [];
  const invalid = [];
  for (const entry of String(c.addresses ?? '')
    .split(/[\s,;]+/)
    .filter((e) => e !== '')) {
    const address = parseAddress(entry);
    if (!address) {
      invalid.push(entry.slice(0, 100));
    } else if (
      !addresses.some((a) => addressKey(a) === addressKey(address)) &&
      addresses.length < LIMITS.addresses
    ) {
      addresses.push(address);
    }
  }
  const names = parseInputNames(c.input_names);
  return {
    addresses,
    invalid: [...invalid, ...names.invalid],
    maxVolume: parseMaxVolume(c.max_volume),
    inputNames: names.options,
  };
}
