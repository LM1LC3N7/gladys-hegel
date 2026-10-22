// -----------------------------------------------------------------------------
// The integration: the Hegel amplifiers at the typed addresses, one
// persistent TCP connection per address (src/hegel/link.js: pushed lines, a
// poll a minute, reconnection spaced out, the time of the last attempt kept
// in /data), the Gladys devices built from them, the commands (validated
// before anything is sent, the volume capped by the configuration, serialized
// per device, each within the 5 s Gladys waits for its ack) and the
// configuration button. index.js only wires the SDK handlers to it
// (src/handlers.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { addressId, addressKey, normalizeConfig, parseAddress } from './config.js';
import { DEFAULT_PORT, DEVICE_TYPE, FEATURES, LIMITS, TIMINGS } from './constants.js';
import { T } from './i18n.js';
import { DeviceError, ERROR_KINDS, HegelLink } from './hegel/link.js';
import { KEYS, cleanText, isInputValue } from './hegel/protocol.js';
import { buildDevice, deviceName, featureKey, inputOptions, stateList } from './model.js';
import { FileStore, emptyData } from './store.js';

const BUTTONS = new Set([FEATURES.POWER_ON, FEATURES.STANDBY, FEATURES.MUTE]);

/**
 * The volume of a command, validated strictly: an integer 0..100 given as a
 * number or as a string of digits. null, '', true, 12.5, '12abc' are refused.
 * @returns {number | undefined}
 */
export function parseVolumeCommand(value) {
  let volume;
  if (typeof value === 'number') {
    volume = value;
  } else if (typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)) {
    volume = Number(value);
  } else {
    return undefined;
  }
  return Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : undefined;
}

/**
 * The value of a mute press (as gladys-linn): 0 (number or "0") asks to
 * unmute; anything else is a press of the push button, which sets the
 * opposite of the mute read from the amplifier.
 */
export const muteIntent = (value) => (value === 0 || value === '0' ? 'unmute' : 'toggle');

const short = (value) => String(value).slice(0, 32);

export class HegelApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'hegel' }),
    store = new FileStore(),
    now = Date.now,
    clock = () => performance.now(),
    timers = globalThis,
    timings = TIMINGS,
    connect,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    /** Wall clock: only for the attempt times written to /data. */
    this.now = now;
    /** Monotonic clock: budgets, deadlines, windows (never moved by NTP). */
    this.clock = clock;
    this.timers = timers;
    this.timings = timings;
    this.connect = connect;
    this.config = normalizeConfig();
    this.data = undefined;
    /** addressKey -> HegelLink */
    this.links = new Map();
    /** device id -> { running, items } */
    this.queues = new Map();
    /** ids of the devices created in Gladys */
    this.created = new Set();
    /** The last `getDevices` failed: asked again at every round until it works. */
    this.createdStale = false;
    /** device id -> timer of the grouped publication of its states */
    this.publishTimers = new Map();
    /** device id -> { timer }: the one wake-up check chain of a device (after Power on) */
    this.wakeChecks = new Map();
    /** Sequence number of the presses (orders Standby and Power on, whatever the clocks). */
    this.pressSeq = 0;
    /** device id -> sequence number of the last Standby asked */
    this.standbySeq = new Map();
    /** device id -> until when (clock) a volume pushed above the cap is lowered (after Power on) */
    this.wakeWatch = new Map();
    /** ids of the devices whose volume is being lowered by watchWakeVolume */
    this.lowering = new Set();
    this.generation = 0;
    /** One per start(): a start overtaken by a newer one stops after its next await. */
    this.epoch = 0;
    this.tickTimer = undefined;
    this.persistTimer = undefined;
    this.configRetryTimer = undefined;
    /** The writes to /data, one after the other. */
    this.saving = Promise.resolve();
    /** The status publications, one after the other (never out of order). */
    this.statusChain = Promise.resolve();
    /** Clock times of the states published in the last minute (global budget). */
    this.stateTimes = [];
    this.lastStatus = undefined;
    this.warned = new Set();
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration: on every connection to Gladys and on
   * every configuration save. The links to the amplifiers are kept (a
   * reconnection to Gladys never drops them); what this app remembered as
   * "already published" is forgotten, since the core forgot it too.
   */
  async start(raw = {}, { connected = false } = {}) {
    const epoch = ++this.epoch;
    const current = () => epoch === this.epoch && this.started;
    this.timers.clearTimeout(this.configRetryTimer);
    this.configRetryTimer = undefined;
    this.config = normalizeConfig(raw);
    this.started = true;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = this.timers.setInterval(() => this.tick(), this.timings.tick);
    if (connected) {
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
    }
    if (!this.data) {
      try {
        this.data = await this.store.load();
      } catch {
        this.data = emptyData();
      }
      if (this.store.corrupted) {
        this.logger.warn('Unreadable /data/hegel.json moved to hegel.json.bad');
      }
    }
    if (!current()) {
      return;
    }
    await this.step('read the Gladys devices', () => this.refreshCreated(epoch));
    if (!current()) {
      return;
    }
    // Neither a configuration save (changed or not) nor a reconnection to
    // Gladys asks a silent address sooner: only a new address gets a link of
    // its own. The Discovery scan is the one explicit retry.
    await this.step('open the links', () => this.syncLinks());
    for (const [name, task] of [
      ['publish the devices', () => this.publishDevices()],
      ['publish the states', () => this.publishAllStates()],
      ['publish the status', () => this.updateStatus()],
    ]) {
      if (!current()) {
        return;
      }
      await this.step(name, task);
    }
  }

  /**
   * On every connection to Gladys: the configuration read, then start(). A
   * failed read is tried again, spaced out (`configRetry`, doubled up to
   * `configRetryMax`), until it works or another start comes first.
   */
  async connected(attempt = 0) {
    this.timers.clearTimeout(this.configRetryTimer);
    this.configRetryTimer = undefined;
    const epoch = this.epoch;
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      if (epoch !== this.epoch) {
        return;
      }
      const delay = Math.min(
        this.timings.configRetryMax,
        this.timings.configRetry * 2 ** Math.min(attempt, 16),
      );
      this.logger.warn(
        `Could not read the configuration (${err.message}), next try in ${delay / 1000} s`,
      );
      this.configRetryTimer = this.timers.setTimeout(() => {
        this.configRetryTimer = undefined;
        this.connected(attempt + 1).catch(() => {});
      }, delay);
      return;
    }
    await this.start(config, { connected: true });
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.epoch += 1;
    this.timers.clearTimeout(this.configRetryTimer);
    this.configRetryTimer = undefined;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    for (const link of this.links.values()) {
      link.stop();
    }
    this.links.clear();
    for (const handle of this.publishTimers.values()) {
      this.timers.clearTimeout(handle);
    }
    this.publishTimers.clear();
    for (const id of [...this.wakeChecks.keys()]) {
      this.cancelWakeCheck(id);
    }
    if (this.persistTimer) {
      return this.saveNow();
    }
    return this.saving;
  }

  /** The background round: the created devices if unread, the status. */
  tick() {
    if (!this.data) {
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() => (this.createdStale ? this.refreshCreated() : undefined))
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Background round failed: ${err.message}`));
  }

  /** Writes /data now (after the writes already started), never two at once. */
  saveNow() {
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    const data = this.data;
    this.saving = this.saving
      .then(() => this.store.save(data))
      .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    return this.saving;
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.saveNow();
    }, this.timings.persistDelay);
  }

  /**
   * Before every connection attempt of a link: its time is written to /data
   * (at most once a minute per address), so a restarted container never asks
   * the amplifier sooner (see `notBefore`).
   */
  async beforeAttempt(link) {
    if (!this.data) {
      return;
    }
    const id = addressId(link);
    const now = this.now();
    const last = this.data.attempts[id];
    if (Number.isFinite(last) && last <= now && now - last < this.timings.attemptSaveEvery) {
      return;
    }
    this.data.attempts[id] = now;
    await this.saveNow();
  }

  /**
   * How long a new link waits before its first attempt: until a minute after
   * the attempt saved in /data (wall clock, the only one that survives a
   * restart; a saved time in the future counts as now).
   */
  firstWait(address) {
    const last = this.data?.attempts?.[addressId(address)];
    if (!Number.isFinite(last)) {
      return 0;
    }
    const now = this.now();
    return Math.max(0, Math.min(last, now) + this.timings.attemptSaveEvery - now);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  /**
   * The command queue of one device: one command at a time. An `urgent`
   * command (mute) goes before the commands still waiting (after the other
   * urgent ones), never before the one already running.
   */
  enqueue(id, task, { urgent = false, key } = {}) {
    let queue = this.queues.get(id);
    if (!queue) {
      queue = { running: false, items: [] };
      this.queues.set(id, queue);
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, urgent, key };
      if (urgent) {
        const index = queue.items.findIndex((i) => !i.urgent);
        queue.items.splice(index === -1 ? queue.items.length : index, 0, item);
      } else {
        queue.items.push(item);
      }
      this.drain(queue);
    });
  }

  /** Drops the commands of `key` still waiting for a device: never sent. */
  cancelQueued(id, key, message) {
    const queue = this.queues.get(id);
    if (!queue) {
      return;
    }
    const dropped = queue.items.filter((i) => i.key === key);
    queue.items = queue.items.filter((i) => i.key !== key);
    for (const item of dropped) {
      item.reject(new DeviceError(ERROR_KINDS.CANCELLED, message));
    }
  }

  async drain(queue) {
    if (queue.running) {
      return;
    }
    queue.running = true;
    while (queue.items.length > 0) {
      const item = queue.items.shift();
      try {
        item.resolve(await item.task());
      } catch (err) {
        item.reject(err);
      }
    }
    queue.running = false;
  }

  // --- Known devices -----------------------------------------------------------

  get devices() {
    return Object.values(this.data?.devices ?? {});
  }

  deviceOf(gladysDevice) {
    return this.devices.find(
      (d) => this.gladys.externalIds(DEVICE_TYPE, d.id).device === gladysDevice?.external_id,
    );
  }

  linkOf(device) {
    return this.links.get(addressKey(device));
  }

  connectedLink(device) {
    const link = this.linkOf(device);
    return link?.connected ? link : undefined;
  }

  /**
   * What is known of a device: the link state when connected, null when it
   * does not answer (or has no link), undefined when nothing is known yet
   * (first connection in progress, or a connection just lost).
   */
  deviceState(device) {
    const link = this.linkOf(device);
    if (!link) {
      return null;
    }
    if (link.connected) {
      return link.state;
    }
    return link.lastError && !link.open ? null : undefined;
  }

  isTyped(device) {
    return this.config.addresses.some((a) => addressKey(a) === addressKey(device));
  }

  /**
   * One link per typed address and per created device. A known device that
   * is neither (address removed from the configuration, never created) is
   * forgotten, unless the created devices could not be read.
   */
  syncLinks({ retry = false } = {}) {
    if (!this.started) {
      return;
    }
    if (!this.createdStale) {
      for (const device of this.devices) {
        if (!this.isTyped(device) && !this.created.has(device.id)) {
          delete this.data.devices[device.id];
          this.persist();
        }
      }
    }
    const wanted = new Map();
    for (const address of this.config.addresses) {
      wanted.set(addressKey(address), address);
    }
    for (const device of this.devices) {
      if (this.created.has(device.id)) {
        wanted.set(addressKey(device), { host: device.host, port: device.port });
      }
    }
    if (!this.createdStale) {
      const ids = new Set([...wanted.values()].map(addressId));
      for (const id of Object.keys(this.data.attempts)) {
        if (!ids.has(id)) {
          delete this.data.attempts[id];
          this.persist();
        }
      }
    }
    for (const [key, link] of this.links) {
      if (!wanted.has(key)) {
        link.stop();
        this.links.delete(key);
      }
    }
    for (const [key, address] of wanted) {
      const existing = this.links.get(key);
      if (existing) {
        if (retry) {
          existing.retrySoon();
        }
        continue;
      }
      const link = new HegelLink({
        address,
        logger: this.logger,
        timings: this.timings,
        timers: this.timers,
        now: this.clock,
        connect: this.connect,
        beforeAttempt: (source) => this.beforeAttempt(source),
        onEvent: (event, source, extra) => this.linkEvent(event, source, extra),
      });
      this.links.set(key, link);
      link.start({ wait: this.firstWait(address) });
    }
  }

  linkEvent(event, link, extra) {
    // A late event of a link replaced or stopped (configuration changed) publishes nothing.
    if (!this.started || this.links.get(link.key) !== link) {
      return;
    }
    const id = addressId(link);
    if (event === 'up') {
      const device = this.remember(link);
      if (device) {
        this.logger.info(`${deviceName(device)} connected`);
        this.publishDevices().catch((err) =>
          this.logger.warn(`Could not publish the devices: ${err.message}`),
        );
        this.schedulePublish(device.id, 0);
      }
    } else if (event === 'update') {
      const device = Object.hasOwn(this.data.devices, id) ? this.data.devices[id] : undefined;
      if (!device) {
        return;
      }
      if (extra === KEYS.INPUT && this.mergeInputs(device, link.state)) {
        this.publishDevices().catch((err) =>
          this.logger.warn(`Could not publish the devices: ${err.message}`),
        );
      }
      if (extra === KEYS.VOLUME || extra === KEYS.POWER) {
        this.watchWakeVolume(device, link);
      }
      this.schedulePublish(device.id);
    } else if (event === 'failed') {
      // The amplifier known at this address does not answer: power 0.
      if (Object.hasOwn(this.data.devices, id)) {
        this.schedulePublish(id, 0);
      }
    }
    this.updateStatus().catch(() => {});
  }

  /** The amplifier answering at the address of `link`, remembered by its address id. */
  remember(link) {
    const table = this.data.devices;
    const id = addressId(link);
    let device = Object.hasOwn(table, id) ? table[id] : undefined;
    if (!device) {
      if (Object.keys(table).length >= LIMITS.devices) {
        this.warnOnce('devices', `More than ${LIMITS.devices} devices: the next ones are ignored`);
        return undefined;
      }
      device = { id, host: link.host, port: link.port, inputOptions: [] };
      table[id] = device;
      this.persist();
    }
    this.mergeInputs(device, link.state);
    return device;
  }

  /**
   * The dropdown only grows: the names typed in the configuration first
   * (they also rename an option), then any input value seen ("Input N").
   * True when it changed.
   */
  mergeInputs(device, state = {}) {
    const options = inputOptions(device);
    let changed = false;
    const offer = (value, label, { relabel }) => {
      if (!isInputValue(value)) {
        return;
      }
      const option = options.find((o) => o.value === value);
      if (option) {
        if (relabel && label && option.label !== label) {
          option.label = label;
          changed = true;
        }
      } else if (options.length < LIMITS.inputs) {
        options.push({ value, label });
        changed = true;
      } else {
        this.warnOnce(`inputs:${device.id}`, `${deviceName(device)}: too many inputs`);
      }
    };
    for (const { value, label } of this.config.inputNames) {
      offer(value, label, { relabel: true });
    }
    if (typeof state.input === 'string') {
      offer(state.input, `Input ${state.input}`, { relabel: false });
    }
    if (changed) {
      options.sort((a, b) => Number(a.value) - Number(b.value));
      device.inputOptions = options;
      this.persist();
    }
    return changed;
  }

  /**
   * The input options of the device created in Gladys (`gladys.devices`,
   * kept up to date by the SDK), merged into the known device: options seen
   * before a reset of /data are never dropped from the created device.
   */
  mergeCreatedOptions(device) {
    const externalId = this.gladys.externalIds(DEVICE_TYPE, device.id).device;
    const created = (Array.isArray(this.gladys.devices) ? this.gladys.devices : []).find(
      (d) => d?.external_id === externalId,
    );
    const feature = (Array.isArray(created?.features) ? created.features : []).find(
      (f) => f?.external_id === `${externalId}:${FEATURES.INPUT}`,
    );
    const options = Array.isArray(feature?.supported_options) ? feature.supported_options : [];
    const own = inputOptions(device);
    let changed = false;
    for (const option of options) {
      if (
        isInputValue(option?.value) &&
        !own.some((o) => o.value === option.value) &&
        own.length < LIMITS.inputs
      ) {
        own.push({
          value: option.value,
          label: cleanText(option.label) ?? `Input ${option.value}`,
        });
        changed = true;
      }
    }
    if (changed) {
      own.sort((a, b) => Number(a.value) - Number(b.value));
      device.inputOptions = own;
      this.persist();
    }
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    const devices = this.devices;
    for (const device of devices) {
      this.mergeCreatedOptions(device);
      this.mergeInputs(device, this.connectedLink(device)?.state);
    }
    await this.gladys.publishDiscoveredDevices(devices.map((d) => buildDevice(this.gladys, d)));
  }

  /**
   * The devices created in Gladys. When `getDevices` fails, the list the SDK
   * keeps (`gladys.devices`) is used, and the call is made again at every
   * round until it works. A created device unknown to /data (file reset) is
   * found again from its external id, which holds its address.
   */
  async refreshCreated(epoch = this.epoch) {
    let list;
    try {
      list = await this.gladys.getDevices();
      if (epoch !== this.epoch) {
        // A newer start reads them itself: this late answer changes nothing.
        return;
      }
      this.createdStale = false;
    } catch (err) {
      if (epoch !== this.epoch) {
        return;
      }
      this.createdStale = true;
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      this.logger.warn(`Could not read the Gladys devices (${err.message}): using the last list`);
      list = this.gladys.devices;
    }
    const prefix = this.gladys.externalIds(DEVICE_TYPE, '').device;
    const created = new Set();
    for (const gladysDevice of Array.isArray(list) ? list : []) {
      const externalId = gladysDevice?.external_id;
      if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
        continue;
      }
      const id = externalId.slice(prefix.length);
      const [host, port = String(DEFAULT_PORT)] = id.split('_');
      const address = /^\d{1,5}$/.test(port) ? parseAddress(`${host}:${port}`) : undefined;
      if (!address || addressId(address) !== id) {
        continue;
      }
      if (!Object.hasOwn(this.data.devices, id)) {
        if (Object.keys(this.data.devices).length >= LIMITS.devices) {
          continue;
        }
        this.data.devices[id] = { id, ...address, inputOptions: [] };
        this.persist();
      }
      created.add(id);
    }
    this.created = created;
  }

  // --- States --------------------------------------------------------------------

  /**
   * The states of a device, grouped: at most one publication per
   * `publishDelay` times the number of created devices, so all the devices
   * together stay near one publication (4 states at most) per `publishDelay`,
   * far under the 300 states a minute of Gladys.
   */
  schedulePublish(id, delay = this.timings.publishDelay * Math.max(1, this.created.size)) {
    if (this.publishTimers.has(id)) {
      if (delay > 0) {
        return;
      }
      this.timers.clearTimeout(this.publishTimers.get(id));
    }
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.publishTimers.delete(id);
      if (generation !== this.generation) {
        return;
      }
      const device = this.data?.devices?.[id];
      if (device) {
        this.publishStates(device).catch(() => {});
      }
    }, delay);
    this.publishTimers.set(id, handle);
  }

  async publishStates(device) {
    if (!this.created.has(device.id)) {
      return;
    }
    const states = stateList(this.gladys, device, this.deviceState(device));
    if (states.length === 0) {
      return;
    }
    // The global budget, every publication counted (grouped, immediate, after
    // a creation or a reconnection): beyond it, the publication is deferred,
    // never lost (the states are read again when it runs).
    const now = this.clock();
    while (this.stateTimes.length > 0 && now - this.stateTimes[0] >= 60_000) {
      this.stateTimes.shift();
    }
    if (this.stateTimes.length + states.length > LIMITS.statesPerMinute) {
      const wait = Math.max(1, Math.ceil(this.stateTimes[0] + 60_000 - now));
      this.warnOnce('budget', 'More states than Gladys accepts in a minute: publications deferred');
      this.schedulePublish(device.id, wait);
      return;
    }
    for (let i = 0; i < states.length; i += 1) {
      this.stateTimes.push(now);
    }
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.logger.warn(`Could not publish the states of ${deviceName(device)}: ${err.message}`);
    }
  }

  async publishAllStates() {
    for (const device of this.devices) {
      await this.publishStates(device);
    }
  }

  /** The Discovery scan of Gladys: the silent addresses asked again, the list published. */
  async scan() {
    this.syncLinks({ retry: true });
    await this.publishDevices();
    return this.devices;
  }

  // --- Commands --------------------------------------------------------------------

  /** Validates a command before anything is queued or sent. */
  validate(device, key, value) {
    if (key === FEATURES.VOLUME) {
      const volume = parseVolumeCommand(value);
      if (volume === undefined) {
        throw new Error(`Invalid volume "${short(value)}": an integer from 0 to 100`);
      }
      return volume;
    }
    if (key === FEATURES.INPUT) {
      if (typeof value !== 'string' || !inputOptions(device).some((o) => o.value === value)) {
        throw new Error(`Unknown input "${short(value)}"`);
      }
      return value;
    }
    if (key === FEATURES.MUTE) {
      return muteIntent(value);
    }
    if (BUTTONS.has(key)) {
      return undefined;
    }
    throw new Error(`Feature "${short(key)}" cannot be commanded`);
  }

  async setValue(gladysDevice, feature, value) {
    const device = this.deviceOf(gladysDevice);
    if (!device) {
      throw new Error(`Unknown device ${short(gladysDevice?.external_id)}`);
    }
    const key = featureKey(gladysDevice.external_id, feature?.external_id);
    const checked = this.validate(device, key, value);
    // The budget runs from the request of Gladys, the wait in the queues
    // included, on the monotonic clock.
    const started = this.clock();
    // `seq` orders the presses (a Standby wins over every Power on pressed
    // before it, whatever the clocks); `late` is set at the deadline, and
    // asked again right before every line of this command leaves;
    // `mayHaveSent` is set just before a line leaves.
    const context = { mayHaveSent: false, late: false, seq: ++this.pressSeq };
    let run;
    if (key === FEATURES.STANDBY) {
      // Standby is never stuck behind the other commands: it skips the device
      // queue (and goes first on the connection), and cancels a Power on still
      // waiting. It leaves the volume checks of a wake-up running: they only
      // lower, and an amplifier busy waking up may ignore the Standby.
      this.standbySeq.set(device.id, context.seq);
      this.cancelQueued(device.id, FEATURES.POWER_ON, 'Cancelled by Standby, nothing sent');
      run = this.command(device, key, checked, started, context);
    } else {
      run = this.enqueue(
        device.id,
        async () => {
          if (context.late || this.remaining(started) < 50) {
            // Gladys stopped waiting while this command was queued: dropped, never sent late.
            context.late = true;
            throw new DeviceError(
              ERROR_KINDS.BUDGET,
              'No time left for this command, nothing sent',
            );
          }
          return this.command(device, key, checked, started, context);
        },
        { urgent: key === FEATURES.MUTE, key },
      );
    }
    // Real timer (not the injectable timers): the ack Gladys waits for.
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          context.late = true;
          reject(
            context.mayHaveSent
              ? new DeviceError(
                  ERROR_KINDS.TIMEOUT,
                  'Sent, without confirmation from the amplifier',
                  { sent: true },
                )
              : new DeviceError(
                  ERROR_KINDS.BUDGET,
                  'No time left for this command (amplifier busy), nothing sent',
                ),
          );
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    run.catch(() => {});
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  remaining(started) {
    return this.timings.commandBudget - (this.clock() - started);
  }

  /** The cap, read right before a volume line leaves: true, or why it may not. */
  capGuard(value) {
    const cap = this.config.maxVolume;
    return Number(value) <= cap ? true : `Volume ${value} above the cap (${cap}): nothing sent`;
  }

  /**
   * Writes one command line and waits for its answer. Right before the bytes
   * leave (in the pump of the link, after any wait on the connection), the
   * deadline of the command, the cap for a volume line and `shouldSend` are
   * asked again: any "no" drops the line, nothing sent. A line that may have
   * reached the amplifier is never reported as "not sent": "sent, without
   * confirmation" (the line pushed by the amplifier shows what it did).
   */
  async send(
    device,
    link,
    key,
    value,
    started,
    context,
    { priority = false, shouldSend, onSent } = {},
  ) {
    const guard = () => {
      if (context.late) {
        return 'No time left for this command, nothing sent';
      }
      if (key === KEYS.VOLUME) {
        const cap = this.capGuard(value);
        if (cap !== true) {
          return cap;
        }
      }
      return shouldSend ? shouldSend() : true;
    };
    try {
      return await link.exchange(key, '=', value, this.remaining(started), {
        priority,
        shouldSend: guard,
        onSent: () => {
          context.mayHaveSent = true;
          onSent?.();
        },
      });
    } catch (err) {
      if (err.kind === ERROR_KINDS.TIMEOUT || err.kind === ERROR_KINDS.CLOSED) {
        throw new DeviceError(
          ERROR_KINDS.TIMEOUT,
          'Sent, without confirmation from the amplifier',
          { sent: true },
        );
      }
      if (err.kind === ERROR_KINDS.ANSWERED_ERROR) {
        throw new DeviceError(
          err.kind,
          `Sent, without confirmation: ${err.message.charAt(0).toLowerCase()}${err.message.slice(1)}`,
          { sent: true },
        );
      }
      if (err.kind === ERROR_KINDS.UNREACHABLE || err.kind === ERROR_KINDS.BUDGET) {
        throw new DeviceError(
          err.kind,
          err.kind === ERROR_KINDS.BUDGET
            ? 'No time left for this command, nothing sent'
            : `${deviceName(device)} is not connected: nothing sent`,
        );
      }
      if (err.kind === ERROR_KINDS.CANCELLED) {
        throw new DeviceError(err.kind, err.message);
      }
      throw err;
    }
  }

  /**
   * A query made before a command line, to decide on the state read again
   * (never on the state in memory): whatever goes wrong, no command was
   * sent. Resolves with the link state right after the answer.
   */
  async readBefore(device, link, what, key, started) {
    const budget = Math.min(this.timings.preRead, this.remaining(started));
    try {
      await link.query(key, budget);
    } catch (err) {
      if (err.kind === ERROR_KINDS.UNREACHABLE) {
        throw new DeviceError(err.kind, `${deviceName(device)} is not connected: nothing sent`);
      }
      if (err.kind === ERROR_KINDS.ANSWERED_ERROR) {
        throw new DeviceError(
          ERROR_KINDS.BUDGET,
          `${what}: the amplifier answered an error, nothing sent`,
        );
      }
      throw new DeviceError(ERROR_KINDS.BUDGET, `${what} not read in time: nothing sent`);
    }
    return link.state;
  }

  /** Whether the volume checks of a wake-up still run for a device (its window). */
  watching(id) {
    return (this.wakeWatch.get(id) ?? -Infinity) >= this.clock();
  }

  async command(device, key, value, started, context) {
    if (key === FEATURES.STANDBY) {
      // Protective: possible as soon as the connection is open, before the
      // first state is read (a link just opened, a restart). A link that is
      // not open: nothing sent, said so ("already in standby" would be a guess).
      const link = this.linkOf(device);
      if (!link?.open) {
        throw new DeviceError(
          ERROR_KINDS.UNREACHABLE,
          `${deviceName(device)} is not connected (off or unreachable): nothing sent`,
        );
      }
      await this.send(device, link, KEYS.POWER, '0', started, context, { priority: true });
      return undefined;
    }
    const link = this.connectedLink(device);
    if (!link) {
      throw new DeviceError(
        ERROR_KINDS.UNREACHABLE,
        `${deviceName(device)} is not connected (off or unreachable): nothing sent`,
      );
    }
    const send = (k, v, options) => this.send(device, link, k, v, started, context, options);
    switch (key) {
      case FEATURES.POWER_ON: {
        // A Standby pressed after this press wins: asked again right before
        // the line is written (it may wait behind a poll query).
        const standbyAfter = () => (this.standbySeq.get(device.id) ?? 0) > context.seq;
        await send(KEYS.POWER, '1', {
          shouldSend: () => (standbyAfter() ? 'Cancelled by Standby, nothing sent' : true),
          // As the line leaves (whatever its answer: late, refused, lost), the
          // wake-up window opens and the checks start over: a press that
          // never left touches neither the window nor the checks running.
          onSent: () => {
            this.wakeWatch.set(
              device.id,
              this.clock() + (this.timings.wakeChecks + 1) * this.timings.wakeCheckDelay,
            );
            this.capAfterWake(device, 1);
          },
        });
        // An amplifier wakes up at its start-up volume: brought back to the
        // cap within what is left of this command first; the checks go on in
        // the background until the end of the window. The ack never depends
        // on it.
        await this.capVolume(device, link, () =>
          Math.min(this.timings.preRead, this.remaining(started) - 100),
        ).catch(() => false);
        return undefined;
      }
      case FEATURES.VOLUME: {
        // Capped here, and the cap asked again right before the line leaves
        // (send): a cap lowered meanwhile drops the line, nothing sent.
        const target = Math.min(value, this.config.maxVolume);
        if (target < value) {
          this.logger.info(`${deviceName(device)}: volume ${value} capped to ${target}`);
        }
        await send(KEYS.VOLUME, String(target));
        return undefined;
      }
      case FEATURES.MUTE: {
        // The mute is read from the amplifier just before. 0 asks to unmute;
        // any other value is a press: the opposite is set explicitly (no toggle).
        const { mute } = await this.readBefore(device, link, 'Mute state', KEYS.MUTE, started);
        if (typeof mute !== 'boolean') {
          throw new Error(`${deviceName(device)}: mute state unknown, nothing sent`);
        }
        const wanted = value === 'unmute' ? false : !mute;
        if (wanted === mute) {
          return undefined;
        }
        if (wanted) {
          await send(KEYS.MUTE, '1');
          return undefined;
        }
        // Unmuting never makes the amplifier play above the cap: the volume
        // read again decides, and is lowered first when above it.
        const { volume } = await this.readBefore(device, link, 'Volume', KEYS.VOLUME, started);
        if (!Number.isInteger(volume)) {
          throw new Error(`${deviceName(device)}: volume unknown, nothing sent`);
        }
        const cap = this.config.maxVolume;
        if (volume > cap) {
          this.logger.info(
            `${deviceName(device)}: volume ${volume} lowered to ${cap} before unmuting`,
          );
          try {
            await send(KEYS.VOLUME, String(cap));
          } catch (err) {
            if (err.sent) {
              throw new DeviceError(
                ERROR_KINDS.TIMEOUT,
                `${deviceName(device)}: volume not lowered to the cap (sent, without confirmation), mute kept`,
                { sent: true },
              );
            }
            throw err;
          }
        }
        // The volume known right before -m.0 leaves decides (a knob turned up
        // while the line waited): above the cap or unknown, the mute is kept.
        await send(KEYS.MUTE, '0', {
          shouldSend: () =>
            Number.isInteger(link.state.volume) && link.state.volume <= this.config.maxVolume
              ? true
              : `${deviceName(device)}: volume above the cap, mute kept, nothing sent`,
        });
        return undefined;
      }
      case FEATURES.INPUT:
        await send(KEYS.INPUT, value);
        return undefined;
      default:
        throw new Error(`Feature "${short(key)}" cannot be commanded`);
    }
  }

  /**
   * Reads the power and the volume, and lowers the volume to the cap when the
   * amplifier is on and above it. True when settled (lowered, or nothing to
   * lower), false when it cannot tell yet (waking up) or did not confirm the
   * lowering. `alive` false stops it. The cap is asked again right before
   * the lowering leaves.
   */
  async capVolume(device, link, budget, alive = () => true) {
    if (budget() <= 0 || !link.connected || !alive()) {
      return false;
    }
    await link.query(KEYS.POWER, budget());
    if (link.state.power !== true || budget() <= 0 || !alive()) {
      return false;
    }
    await link.query(KEYS.VOLUME, budget());
    const volume = link.state.volume;
    if (!Number.isInteger(volume)) {
      return false;
    }
    const cap = this.config.maxVolume;
    if (volume <= cap) {
      return true;
    }
    if (budget() <= 0) {
      return false;
    }
    this.logger.info(`${deviceName(device)}: woke up at volume ${volume}, lowered to ${cap}`);
    await link.exchange(KEYS.VOLUME, '=', String(cap), budget(), {
      shouldSend: () => this.capGuard(cap),
    });
    // Settled only on the volume the amplifier gives back, never on the command alone.
    return link.state.volume <= this.config.maxVolume;
  }

  /**
   * A volume pushed above the cap while an amplifier wakes up (within the
   * window opened by a Power on that left; a Standby does not close it):
   * lowered through the device queue, one at a time per device. A lowering
   * not confirmed is tried again by the checks while the window is open.
   */
  watchWakeVolume(device, link) {
    if (!this.watching(device.id) || this.lowering.has(device.id)) {
      return;
    }
    if (link.state.power !== true || !(link.state.volume > this.config.maxVolume)) {
      return;
    }
    this.lowering.add(device.id);
    this.enqueue(device.id, () => {
      const current = this.connectedLink(device);
      return current && this.watching(device.id)
        ? this.capVolume(device, current, () => this.timings.preRead)
        : false;
    })
      .catch(() => false)
      .then((done) => {
        if (!done && this.watching(device.id) && !this.wakeChecks.has(device.id)) {
          this.capAfterWake(device, 1);
        }
      })
      .finally(() => this.lowering.delete(device.id));
  }

  /** Cancels the wake-up check chain of a device, if any. */
  cancelWakeCheck(id) {
    const chain = this.wakeChecks.get(id);
    if (chain) {
      this.timers.clearTimeout(chain.timer);
      this.wakeChecks.delete(id);
    }
  }

  /**
   * After a Power on that left: the cap checked every `wakeCheckDelay`,
   * `wakeChecks` times, through the device queue, until the end of the
   * window (a volume read under the cap once does not end them: an amplifier
   * may apply its start-up volume later without pushing it). One chain per
   * device: a new chain (another Power on that left) replaces the running
   * one; a Standby does not stop it (the checks only lower, and only an
   * amplifier on).
   */
  capAfterWake(device, attempt, chain = { timer: undefined }, lastDone = false) {
    if (attempt === 1) {
      this.cancelWakeCheck(device.id);
      this.wakeChecks.set(device.id, chain);
    }
    const current = () => this.wakeChecks.get(device.id) === chain;
    if (attempt > this.timings.wakeChecks) {
      this.wakeChecks.delete(device.id);
      if (!lastDone) {
        this.logger.info(`${deviceName(device)}: volume not confirmed after waking up`);
      }
      return;
    }
    const generation = this.generation;
    chain.timer = this.timers.setTimeout(() => {
      if (generation !== this.generation || !current()) {
        return;
      }
      this.enqueue(device.id, async () => {
        const link = this.connectedLink(device);
        if (!link || !current()) {
          return false;
        }
        return this.capVolume(device, link, () => this.timings.preRead, current);
      })
        .catch(() => false)
        .then((done) => {
          if (current()) {
            this.capAfterWake(device, attempt + 1, chain, done);
          }
        });
    }, this.timings.wakeCheckDelay);
  }

  // --- Device lifecycle --------------------------------------------------------------

  async deviceCreated(gladysDevice) {
    const device = this.deviceOf(gladysDevice);
    if (!device) {
      return;
    }
    this.created.add(device.id);
    this.syncLinks();
    // The SDK forgot what was published for this device: everything again.
    await this.publishStates(device);
    await this.updateStatus();
  }

  async deviceDeleted(gladysDevice) {
    const device = this.deviceOf(gladysDevice);
    if (device) {
      this.created.delete(device.id);
      this.syncLinks();
      await this.updateStatus();
    }
  }

  // --- Configuration screen button --------------------------------------------------

  /** What is known, from memory only: the button never asks the amplifiers faster. */
  async checkDevices() {
    if (this.devices.length === 0 && this.config.addresses.length === 0) {
      return T.noDevice;
    }
    const keys = new Set();
    const lines = [];
    for (const target of [...this.devices, ...this.config.addresses]) {
      const key = addressKey(target);
      if (keys.has(key)) {
        continue;
      }
      keys.add(key);
      const link = this.links.get(key);
      lines.push(
        T.checkLine(
          `Hegel ${key}`,
          link?.connected ? link.state : undefined,
          link?.lastError ? short(link.lastError.message) : undefined,
        ),
      );
    }
    return T.check(lines, this.config);
  }

  // --- Status ---------------------------------------------------------------------

  /** The typed addresses where no amplifier answers yet. */
  silentAddresses() {
    return this.config.addresses
      .filter((a) => !Object.hasOwn(this.data.devices, addressId(a)))
      .filter((a) => {
        const link = this.links.get(addressKey(a));
        return link && !link.connected && link.lastError;
      })
      .map(addressKey);
  }

  /**
   * The status, one publication at a time: each one is computed when its
   * turn comes, so the last one published is always the latest state.
   */
  updateStatus() {
    const run = this.statusChain.then(() => this.publishStatus());
    this.statusChain = run.catch(() => {});
    return run;
  }

  async publishStatus() {
    if (!this.started || !this.data) {
      return;
    }
    const generation = this.generation;
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    const silent = this.silentAddresses();
    if (silent.length > 0) {
      notes.push(T.noAnswerAt(silent));
    }
    const off = this.devices
      .filter((d) => this.created.has(d.id) && this.deviceState(d) === null)
      .map(deviceName);
    if (off.length > 0) {
      notes.push(T.unreachable(off));
    }
    // A local integration without an account: "connected" means running; what
    // does not answer is said in the message.
    const status = { connected: true };
    if (notes.length > 0) {
      status.message = {
        en: notes.map((n) => n.en).join(' '),
        fr: notes.map((n) => n.fr).join(' '),
      };
    }
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      if (generation === this.generation) {
        this.lastStatus = key;
      }
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}
