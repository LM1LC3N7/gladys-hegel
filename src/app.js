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

const short = (value) => String(value).slice(0, 32);

export class HegelApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'hegel' }),
    store = new FileStore(),
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
    connect,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
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
    /** device id -> when the last Standby was asked */
    this.standbyAt = new Map();
    /** device id -> until when a volume pushed above the cap is lowered (after Power on) */
    this.wakeWatch = new Map();
    /** ids of the devices whose volume is being lowered by watchWakeVolume */
    this.lowering = new Set();
    this.generation = 0;
    this.tickTimer = undefined;
    this.persistTimer = undefined;
    /** The writes to /data, one after the other. */
    this.saving = Promise.resolve();
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
    await this.step('read the Gladys devices', () => this.refreshCreated());
    // A configuration save asks the silent addresses again (never sooner than
    // the base interval); a reconnection to Gladys does not: Gladys flapping
    // must never make the amplifiers asked faster.
    await this.step('open the links', () => this.syncLinks({ retry: !connected }));
    await this.step('publish the devices', () => this.publishDevices());
    await this.step('publish the states', () => this.publishAllStates());
    await this.step('publish the status', () => this.updateStatus());
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

  /** The first attempt allowed for an address after a start: a minute after the saved one. */
  notBefore(address) {
    const last = this.data?.attempts?.[addressId(address)];
    return Number.isFinite(last)
      ? Math.min(last, this.now()) + this.timings.attemptSaveEvery
      : -Infinity;
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
        now: this.now,
        connect: this.connect,
        beforeAttempt: (source) => this.beforeAttempt(source),
        onEvent: (event, source, extra) => this.linkEvent(event, source, extra),
      });
      this.links.set(key, link);
      link.start({ notBefore: this.notBefore(address) });
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
  async refreshCreated() {
    let list;
    try {
      list = await this.gladys.getDevices();
      this.createdStale = false;
    } catch (err) {
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
    // The budget runs from the request of Gladys, the wait in the queues included.
    const started = this.now();
    let late = false;
    // Set just before a command line leaves: from then on, it may have
    // reached the amplifier, whatever happens next.
    const context = { mayHaveSent: false };
    let run;
    if (key === FEATURES.STANDBY) {
      // Standby is never stuck behind the other commands: it skips the device
      // queue (and goes first on the connection), and cancels a Power on still
      // waiting and the volume checks after a wake-up.
      this.standbyAt.set(device.id, started);
      this.wakeWatch.delete(device.id);
      this.cancelWakeCheck(device.id);
      this.cancelQueued(device.id, FEATURES.POWER_ON, 'Cancelled by Standby, nothing sent');
      run = this.command(device, key, checked, started, context);
    } else {
      run = this.enqueue(
        device.id,
        async () => {
          if (late || this.remaining(started) < 50) {
            // Gladys stopped waiting while this command was queued: dropped, never sent late.
            late = true;
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
    // Wall-clock deadline (not the injectable timers): the ack Gladys waits for.
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          late = true;
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
    return this.timings.commandBudget - (this.now() - started);
  }

  /**
   * Writes one command line and waits for its answer. A line that may have
   * reached the amplifier is never reported as "not sent": "sent, without
   * confirmation" (the line pushed by the amplifier shows what it did).
   */
  async send(device, link, key, value, started, context, { priority = false, shouldSend } = {}) {
    try {
      return await link.exchange(key, '=', value, this.remaining(started), {
        priority,
        shouldSend,
        onSent: () => {
          context.mayHaveSent = true;
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
        throw new DeviceError(err.kind, 'Cancelled by Standby, nothing sent');
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
      throw new DeviceError(ERROR_KINDS.BUDGET, `${what} not read in time: nothing sent`);
    }
    return link.state;
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
        // A new press starts over: the check chain of the previous one stops.
        this.cancelWakeCheck(device.id);
        // A Standby asked after this press wins: checked again right before
        // the line is written (it may wait behind a poll query on the
        // connection), and before every step after it.
        const alive = () => (this.standbyAt.get(device.id) ?? -Infinity) < started;
        await send(KEYS.POWER, '1', { shouldSend: alive });
        if (!alive()) {
          return undefined;
        }
        // A volume pushed above the cap while the amplifier wakes up is lowered too.
        this.wakeWatch.set(
          device.id,
          this.now() + this.timings.wakeChecks * this.timings.wakeCheckDelay,
        );
        // An amplifier wakes up at its start-up volume: brought back to the
        // cap. Within what is left of this command first, then in the
        // background while it is still waking up. The ack never depends on it.
        const done = await this.capVolume(
          device,
          link,
          () => Math.min(this.timings.preRead, this.remaining(started) - 100),
          alive,
        ).catch(() => false);
        if (!done && alive()) {
          this.capAfterWake(device, 1);
        }
        return undefined;
      }
      case FEATURES.VOLUME: {
        // The cap is read here, just before the line leaves: a configuration
        // saved while the command waited in the queue applies.
        const target = Math.min(value, this.config.maxVolume);
        if (target < value) {
          this.logger.info(`${deviceName(device)}: volume ${value} capped to ${target}`);
        }
        await send(KEYS.VOLUME, String(target));
        return undefined;
      }
      case FEATURES.MUTE: {
        // Gladys sends a press, not a target: the mute is read from the
        // amplifier just before, and the opposite is set explicitly (no toggle).
        const { mute } = await this.readBefore(device, link, 'Mute state', KEYS.MUTE, started);
        if (typeof mute !== 'boolean') {
          throw new Error(`${deviceName(device)}: mute state unknown, nothing sent`);
        }
        if (mute) {
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
            // Unmuted only once the amplifier says it is at or under the cap.
            if (!(link.state.volume <= cap)) {
              throw new DeviceError(
                ERROR_KINDS.TIMEOUT,
                `${deviceName(device)}: volume not lowered to the cap, mute kept`,
                { sent: true },
              );
            }
          }
        }
        await send(KEYS.MUTE, mute ? '0' : '1');
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
   * lowering (the checks go on). `alive` false stops it.
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
    await link.exchange(KEYS.VOLUME, '=', String(cap), budget());
    // Settled only on the volume the amplifier gives back, never on the command alone.
    return link.state.volume <= this.config.maxVolume;
  }

  /**
   * A volume pushed above the cap while an amplifier wakes up (within the
   * window of the checks after Power on): lowered through the device queue,
   * one at a time per device.
   */
  watchWakeVolume(device, link) {
    const until = this.wakeWatch.get(device.id);
    if (until === undefined || this.now() > until || this.lowering.has(device.id)) {
      return;
    }
    if (link.state.power !== true || !(link.state.volume > this.config.maxVolume)) {
      return;
    }
    this.lowering.add(device.id);
    this.enqueue(device.id, () => {
      const current = this.connectedLink(device);
      return current && this.wakeWatch.has(device.id)
        ? this.capVolume(device, current, () => this.timings.preRead)
        : false;
    })
      .catch(() => false)
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
   * After a Power on: the cap checked again every `wakeCheckDelay`,
   * `wakeChecks` times at most, through the device queue. One chain per
   * device: a new chain (another Power on) replaces the running one; Standby
   * cancels it.
   */
  capAfterWake(device, attempt, chain = { timer: undefined }) {
    if (attempt === 1) {
      this.cancelWakeCheck(device.id);
      this.wakeChecks.set(device.id, chain);
    }
    const current = () => this.wakeChecks.get(device.id) === chain;
    if (attempt > this.timings.wakeChecks) {
      this.wakeChecks.delete(device.id);
      this.logger.info(`${deviceName(device)}: volume not confirmed after waking up`);
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
          return !current();
        }
        return this.capVolume(device, link, () => this.timings.preRead, current);
      })
        .catch(() => false)
        .then((done) => {
          if (!current()) {
            return;
          }
          if (done) {
            this.wakeChecks.delete(device.id);
          } else {
            this.capAfterWake(device, attempt + 1, chain);
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

  async updateStatus() {
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
