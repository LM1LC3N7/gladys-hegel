// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume, file mode 0600): the known devices by address id, the inputs they
// have shown (the "Input" dropdown only grows), and the time of the last
// connection attempt per address (a restarted container never asks sooner
// than the base interval). No secret: the Hegel control port has none.
//
// The tables have no prototype; a key is kept only when it is the id of its
// own, valid address.
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addressId, parseAddress } from './config.js';
import { LIMITS } from './constants.js';
import { cleanText, isInputValue } from './hegel/protocol.js';

export const emptyData = () => ({
  devices: Object.create(null),
  attempts: Object.create(null),
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function sanitizeOptions(options) {
  const seen = new Set();
  const result = [];
  for (const option of Array.isArray(options) ? options.slice(0, LIMITS.inputs * 4) : []) {
    if (
      isObject(option) &&
      isInputValue(option.value) &&
      !seen.has(option.value) &&
      result.length < LIMITS.inputs
    ) {
      seen.add(option.value);
      result.push({
        value: option.value,
        label: cleanText(option.label) ?? `Input ${option.value}`,
      });
    }
  }
  return result;
}

/** An address id of its own valid address (`host` or `host_port`), else undefined. */
function validId(id) {
  if (typeof id !== 'string') {
    return undefined;
  }
  const [host, port, extra] = id.split('_');
  if (extra !== undefined) {
    return undefined;
  }
  const address = parseAddress(port === undefined ? host : `${host}:${port}`);
  return address && addressId(address) === id ? address : undefined;
}

function sanitize(data) {
  const base = emptyData();
  if (!isObject(data)) {
    return base;
  }
  if (isObject(data.devices)) {
    for (const [id, device] of Object.entries(data.devices).slice(0, LIMITS.devices)) {
      const address = validId(id);
      if (!address || !isObject(device) || device.id !== id) {
        continue;
      }
      base.devices[id] = {
        id,
        host: address.host,
        port: address.port,
        inputOptions: sanitizeOptions(device.inputOptions),
      };
    }
  }
  if (isObject(data.attempts)) {
    for (const [id, at] of Object.entries(data.attempts).slice(
      0,
      LIMITS.devices + LIMITS.addresses,
    )) {
      if (validId(id) && Number.isFinite(at) && at > 0) {
        base.attempts[id] = at;
      }
    }
  }
  return base;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = 'hegel.json' } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.corrupted = false;
  }

  /**
   * The saved data. An unreadable file is moved aside to `hegel.json.bad` and
   * `corrupted` is set, so the app says so instead of silently starting over.
   */
  async load() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return emptyData();
    }
    try {
      return sanitize(JSON.parse(text));
    } catch {
      this.corrupted = true;
      const bad = `${this.path}.bad`;
      await rename(this.path, bad).catch(() => {});
      await chmod(bad, 0o600).catch(() => {});
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saves = 0;
    this.corrupted = false;
  }

  async load() {
    return sanitize(JSON.parse(JSON.stringify(this.data)));
  }

  async save(data) {
    // Through JSON, as the file store: what a restart would read back.
    this.data = JSON.parse(JSON.stringify(data));
    this.saves += 1;
  }
}

export { sanitize as sanitizeData };
