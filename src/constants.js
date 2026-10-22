// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <address id>)`, see `addressId` in src/config.js. */
export const DEVICE_TYPE = 'hegel';

export const FEATURES = Object.freeze({
  /** Read only: 1 on, 0 in standby (or unreachable). */
  POWER: 'power',
  /** Push button: `-p.1`. */
  POWER_ON: 'power_on',
  /** Push button: `-p.0` (standby). */
  STANDBY: 'standby',
  /** 0..100, the volume of the amplifier itself; a command is capped by `max_volume`. */
  VOLUME: 'volume',
  /** Push button: each press sets the opposite of the mute read from the amplifier. */
  MUTE: 'mute',
  /** The selected input (`-i.<n>`), a dropdown. */
  INPUT: 'input',
});

export const ACTIONS = Object.freeze({
  CHECK: 'check_devices',
});

/** The Hegel IP control port (plain ASCII lines, ended by a carriage return). */
export const DEFAULT_PORT = 50001;

/**
 * The volume cap of the configuration, on the scale of the amplifier
 * (0..100, what its display shows). No command of Gladys sets more.
 */
export const MAX_VOLUME = Object.freeze({ min: 1, max: 100, default: 40 });

/** Inputs `-i.1` .. `-i.20` (the largest models have about a dozen). */
export const INPUTS = Object.freeze({ min: 1, max: 20 });

export const TIMINGS = Object.freeze({
  /** Opening the TCP connection. */
  connectTimeout: 4_000,
  /** One query while connecting or polling. */
  requestTimeout: 1_500,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (wait in the
   * queues and every exchange included) gets `commandBudget`, the state read
   * just before a mute press `preRead` of it.
   */
  commandBudget: 3_500,
  preRead: 1_500,
  /**
   * Reconnection: first after `reconnectBase`, then doubled each time up to
   * `reconnectMax`. The count is only reset by a connection that stayed up
   * `stableAfter`.
   */
  reconnectBase: 10_000,
  reconnectMax: 5 * 60_000,
  stableAfter: 60_000,
  /** The time of the last connection attempt is written to /data at most this often. */
  attemptSaveEvery: 60_000,
  /** The states are read again this often (the amplifier also pushes its changes). */
  pollInterval: 60_000,
  /** This many polls in a row without an answer to `-p.?` close the connection. */
  deadPolls: 2,
  /** After a Power on whose volume could not be read in time: checked again. */
  wakeCheckDelay: 2_500,
  wakeChecks: 6,
  /** The states of one device are published at most this often (a knob turned fast). */
  publishDelay: 1_000,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
  /** The background round: status, created devices read again. */
  tick: 30_000,
  /** More lines than this within `floodWindow`: the connection is closed. */
  floodLines: 300,
  floodWindow: 10_000,
});

export const LIMITS = Object.freeze({
  devices: 20,
  addresses: 20,
  /** Length of one line from the amplifier; longer ones are dropped. */
  line: 64,
  /** Options of the Input dropdown. */
  inputs: INPUTS.max,
  /** Exchanges waiting for their turn on one connection. */
  pending: 16,
  /** Length of a name (input label). */
  name: 64,
});
