// -----------------------------------------------------------------------------
// Review 1: the hostile scenarios H1 to H10 (inverted: they now hold) and
// the minor points M2 to M8. Same harness as app.test.js: the real handlers,
// the SDK's fake Gladys, the fake amplifier on the loopback interface.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HegelApp, muteIntent } from '../src/app.js';
import { LIMITS, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { startFakeHegel } from './fixtures/fakeHegel.js';

const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

const FAST = {
  ...TIMINGS,
  connectTimeout: 500,
  requestTimeout: 300,
  reconnectBase: 40,
  reconnectMax: 200,
  stableAfter: 10_000,
  attemptSaveEvery: 300,
  publishDelay: 5,
  persistDelay: 5,
  wakeCheckDelay: 30,
  configRetry: 30,
  configRetryMax: 100,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function setup(t, { deviceOptions = {}, timings = {}, config = {}, now } = {}) {
  const fake = await startFakeHegel(deviceOptions);
  t.after(() => fake.close());
  const base = { addresses: `127.0.0.1:${fake.port}`, ...config };
  const gladys = createFakeGladys({ selector: 'hegel', config: base });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const app = new HegelApp({
    gladys,
    logger,
    store: new MemoryStore(),
    timers,
    timings: { ...FAST, ...timings },
    ...(now ? { now } : {}),
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  await gladys.connect();
  const id = (key) => `ext:hegel:hegel:127.0.0.1_${fake.port}${key ? `:${key}` : ''}`;
  await waitFor(
    () => gladys.fake.discoveredDevices.some((d) => d.external_id === id()),
    'discovered',
  );
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === id());
  await gladys.fake.deviceCreated(device);
  const link = [...app.links.values()][0];
  await waitFor(() => link.connected, 'connected');
  const set = (key, value = 1) =>
    gladys.fake.setValue(
      device,
      device.features.find((f) => f.external_id === id(key)),
      value,
    );
  return { fake, gladys, app, link, logs, set, base, id, device };
}

// --- I1: the cap after a Power on that left, whatever its answer ------------------------

test('H1: a Power on answered late still gets the cap checks', async (t) => {
  const ctx = await setup(t, {
    deviceOptions: { state: { p: '0' }, wakeVolume: '85' },
    timings: { commandBudget: 600 },
  });
  ctx.fake.delays.p = 900;
  const ack = await ctx.set('power_on');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent, without confirmation/);
  delete ctx.fake.delays.p;
  await waitFor(() => ctx.fake.commands().includes('-v.40'), 'the volume capped');
  assert.equal(ctx.fake.state.v, '40');
});

test('H1 variant: a Power on answered by an error line still gets the cap checks', async (t) => {
  const ctx = await setup(t, { deviceOptions: { state: { p: '0' }, errors: ['p'] } });
  const ack = await ctx.set('power_on');
  assert.match(ack.error, /answered an error \(3\)/);
  // It woke up anyway, at its start-up volume, and pushes nothing.
  ctx.fake.state.p = '1';
  ctx.fake.state.v = '85';
  await waitFor(() => ctx.fake.commands().includes('-v.40'), 'the volume capped');
  assert.equal(ctx.fake.state.v, '40');
});

test('H1 variant: a Power on whose connection closed still gets the cap checks', async (t) => {
  const ctx = await setup(t, { deviceOptions: { state: { p: '0' } } });
  ctx.fake.unanswered.add('p');
  const ack = ctx.set('power_on');
  await waitFor(() => ctx.fake.received.includes('-p.1'), 'the line');
  ctx.fake.unanswered.delete('p');
  ctx.fake.state.p = '1';
  ctx.fake.state.v = '85';
  ctx.fake.dropAll();
  const result = await ack;
  assert.match(result.error, /Sent, without confirmation/);
  await waitFor(
    () => ctx.fake.commands().includes('-v.40'),
    'the volume capped after reconnecting',
  );
});

test('a Power on that never left touches neither the window nor the checks', async (t) => {
  const ctx = await setup(t, { deviceOptions: { state: { p: '0' } } });
  ctx.app.links.get(ctx.link.key).socket.destroy();
  const ack = await ctx.set('power_on');
  assert.match(ack.error, /nothing sent/);
  assert.equal(ctx.app.wakeWatch.size, 0);
  assert.equal(ctx.app.wakeChecks.size, 0);
});

// --- I2: Standby and a second Power on keep the net ---------------------------------------

test('H2: a Standby ignored during the wake-up keeps the cap net', async (t) => {
  const ctx = await setup(t, {
    deviceOptions: { state: { p: '0' } },
    timings: { commandBudget: 600, wakeCheckDelay: 400 },
  });
  assert.equal((await ctx.set('power_on')).success, true);
  ctx.fake.ignoreSet.add('p');
  const off = await ctx.set('standby');
  assert.match(off.error, /Sent, without confirmation/);
  ctx.fake.state.v = '85';
  ctx.fake.push('-v.85');
  await waitFor(() => ctx.fake.commands().includes('-v.40'), 'the volume lowered');
  assert.equal(ctx.fake.state.v, '40');
});

test('H3: a second Power on refused keeps the checks of the first', async (t) => {
  const ctx = await setup(t, {
    deviceOptions: { state: { p: '0' }, wakeVolume: '85' },
    timings: { preRead: 150, requestTimeout: 150, wakeCheckDelay: 60 },
  });
  ctx.fake.unanswered.add('v');
  assert.equal((await ctx.set('power_on')).success, true);
  assert.equal(ctx.app.wakeChecks.size, 1);
  ctx.fake.errors.add('p');
  const again = await ctx.set('power_on');
  assert.match(again.error, /answered an error \(3\)/);
  ctx.fake.unanswered.delete('v');
  await waitFor(() => ctx.fake.commands().includes('-v.40'), 'the volume lowered');
  assert.equal(ctx.fake.state.v, '40');
});

test('H10: a lowering ignored once is tried again while the window is open', async (t) => {
  const ctx = await setup(t, {
    deviceOptions: { state: { p: '0' } },
    timings: { wakeCheckDelay: 500, preRead: 200, requestTimeout: 200 },
  });
  assert.equal((await ctx.set('power_on')).success, true);
  ctx.fake.ignoreSet.add('v');
  ctx.fake.state.v = '85';
  ctx.fake.push('-v.85');
  await waitFor(() => ctx.fake.commands().includes('-v.40'), 'the first lowering');
  await sleep(300);
  ctx.fake.ignoreSet.delete('v');
  await waitFor(() => ctx.fake.state.v === '40', 'the volume lowered again', 4_000);
  assert.ok(ctx.fake.commands().filter((l) => l === '-v.40').length >= 2);
});

test('the checks go on to the end of the window after a volume read under the cap', async (t) => {
  const ctx = await setup(t, {
    deviceOptions: { state: { p: '0' } },
    timings: { wakeCheckDelay: 80 },
  });
  assert.equal((await ctx.set('power_on')).success, true);
  // Applied later, not pushed: only a check can see it.
  ctx.fake.state.v = '85';
  await waitFor(() => ctx.fake.commands().includes('-v.40'), 'the volume lowered');
  assert.equal(ctx.fake.state.v, '40');
});

// --- I3: the cap asked again right before the line leaves ---------------------------------

test('H4: a cap lowered while a volume line waits on the connection drops the line', async (t) => {
  const ctx = await setup(t, { config: { max_volume: 80 } });
  ctx.fake.delays.i = 400;
  const query = ctx.link.query('i', 1000);
  await waitFor(() => ctx.fake.received.at(-1) === '-i.?', 'the poll query');
  const ack = ctx.set('volume', 80);
  await sleep(50);
  await ctx.gladys.fake.configUpdated({ ...ctx.base, max_volume: 30 });
  await query;
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /above the cap \(30\): nothing sent/);
  assert.ok(!ctx.fake.commands().includes('-v.80'));
});

test('H5: a volume turned up while -m.0 waits keeps the mute, nothing sent', async (t) => {
  const ctx = await setup(t, { deviceOptions: { state: { m: '1', v: '30' } } });
  ctx.fake.delays.i = 300;
  ctx.fake.delays.v = 120;
  const ack = ctx.set('mute');
  await waitFor(() => ctx.fake.received.at(-1) === '-v.?', 'the volume read');
  const query = ctx.link.query('i', 1000);
  await sleep(150);
  ctx.fake.state.v = '90';
  ctx.fake.push('-v.90');
  await query;
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /volume above the cap, mute kept, nothing sent/);
  assert.equal(ctx.fake.state.m, '1');
  assert.ok(!ctx.fake.commands().includes('-m.0'));
});

// --- M1: monotonic clock, press order ----------------------------------------------------

test('H6: the wall clock stepped back never sends a line after its deadline', async (t) => {
  let offset = 0;
  const ctx = await setup(t, {
    deviceOptions: { state: { p: '0' } },
    timings: { commandBudget: 600 },
    now: () => Date.now() + offset,
  });
  ctx.fake.delays.i = 900;
  const query = ctx.link.query('i', 1000);
  await waitFor(() => ctx.fake.received.at(-1) === '-i.?', 'the poll query');
  const on = ctx.set('power_on');
  await sleep(30);
  offset = -5000;
  const result = await on;
  await query;
  await sleep(100);
  assert.equal(result.success, false);
  assert.match(result.error, /nothing sent/);
  assert.deepEqual(ctx.fake.commands(), []);
});

test('H7: Standby wins over an earlier Power on whatever the wall clock', async (t) => {
  let offset = 0;
  const ctx = await setup(t, {
    deviceOptions: { state: { p: '0' }, quietWhenOff: true },
    now: () => Date.now() + offset,
  });
  const poll = ctx.link.poll();
  await waitFor(() => ctx.fake.received.at(-1) === '-v.?', 'the poll volume query');
  const on = ctx.set('power_on');
  await sleep(20);
  offset = -5000;
  const off = ctx.set('standby');
  const [a, b] = await Promise.all([on, off]);
  await poll;
  await sleep(100);
  assert.equal(b.success, true);
  assert.match(a.error, /Cancelled by Standby, nothing sent/);
  assert.deepEqual(ctx.fake.commands(), ['-p.0']);
});

// --- M2: the mute value ------------------------------------------------------------------

test('M2: mute 0 unmutes (cap first) or does nothing; any other value is a press', async (t) => {
  assert.equal(muteIntent(0), 'unmute');
  assert.equal(muteIntent('0'), 'unmute');
  assert.equal(muteIntent(1), 'toggle');
  const ctx = await setup(t, { deviceOptions: { state: { m: '0', v: '30' } } });
  assert.equal((await ctx.set('mute', 0)).success, true);
  assert.deepEqual(ctx.fake.commands(), [], 'already unmuted: nothing sent');
  assert.equal((await ctx.set('mute', 1)).success, true);
  assert.deepEqual(ctx.fake.commands(), ['-m.1']);
  ctx.fake.state.v = '70';
  assert.equal((await ctx.set('mute', 0)).success, true);
  assert.deepEqual(ctx.fake.commands(), ['-m.1', '-v.40', '-m.0']);
});

// --- M4: an unchanged configuration never asks sooner ------------------------------------

test('M4: a configuration saved again never asks an address sooner; the scan does', async (t) => {
  const ctx = await setup(t);
  let retries = 0;
  ctx.link.retrySoon = () => {
    retries += 1;
  };
  await ctx.gladys.fake.configUpdated(ctx.base);
  await ctx.gladys.fake.configUpdated(ctx.base);
  assert.equal(retries, 0);
  await ctx.app.scan();
  assert.equal(retries, 1);
});

// --- M5: one budget for every publication ------------------------------------------------

test('M5: beyond the global budget, a publication is deferred, never lost', async (t) => {
  const ctx = await setup(t);
  await waitFor(() => ctx.gladys.fake.lastState(ctx.id('power')) === 1, 'the states');
  const count = ctx.gladys.fake.states.length;
  const now = ctx.app.clock();
  ctx.app.stateTimes = Array.from({ length: LIMITS.statesPerMinute - 1 }, () => now);
  ctx.fake.push('-v.12');
  await sleep(100);
  assert.equal(ctx.gladys.fake.states.length, count, 'deferred');
  const device = ctx.app.devices[0];
  assert.ok(ctx.app.publishTimers.has(device.id), 'scheduled again');
  ctx.app.stateTimes = [];
  await ctx.app.publishStates(device);
  assert.equal(ctx.gladys.fake.lastState(ctx.id('volume')), 12);
});

// --- M6: statuses one at a time, starts by epoch ------------------------------------------

test('M6: the statuses are published one at a time, the last one last', async (t) => {
  const ctx = await setup(t);
  let inFlight = 0;
  let most = 0;
  const seen = [];
  ctx.gladys.setConnectionStatus = async (connected, message) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await sleep(20);
    seen.push(message?.en ?? '');
    inFlight -= 1;
  };
  ctx.app.config = { ...ctx.app.config, invalid: ['a'] };
  const first = ctx.app.updateStatus();
  ctx.app.config = { ...ctx.app.config, invalid: ['b'] };
  const second = ctx.app.updateStatus();
  await Promise.all([first, second]);
  assert.equal(most, 1);
  assert.match(seen.at(-1), /invalid\): b/);
});

test('M6: a start overtaken by a newer one does not overwrite what it read', async (t) => {
  const ctx = await setup(t);
  const list = ctx.gladys.devices;
  let calls = 0;
  ctx.gladys.getDevices = async () => {
    calls += 1;
    if (calls === 1) {
      await sleep(100);
      return [];
    }
    return list;
  };
  const old = ctx.app.start(ctx.base);
  await sleep(10);
  await ctx.app.start(ctx.base);
  await old;
  assert.equal(ctx.app.created.size, 1);
});

// --- M7: a failed configuration read on connection is tried again ------------------------

test('M7: getConfig failing on connection is tried again, spaced out', async (t) => {
  const gladys = createFakeGladys({ selector: 'hegel', config: { addresses: '' } });
  const app = new HegelApp({
    gladys,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    store: new MemoryStore(),
    timers,
    timings: FAST,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  await gladys.connect();
  // A later connection to Gladys, whose configuration read fails twice.
  const real = gladys.getConfig.bind(gladys);
  let calls = 0;
  gladys.getConfig = async () => {
    calls += 1;
    if (calls < 3) {
      throw new Error('busy');
    }
    return real();
  };
  let starts = 0;
  const start = app.start.bind(app);
  app.start = (...args) => {
    starts += 1;
    return start(...args);
  };
  await app.connected();
  assert.equal(starts, 0);
  await waitFor(() => starts === 1, 'started after the retries');
  assert.equal(calls, 3);
});

test('review 2, A5: a late configuration read never overwrites a newer save', async (t) => {
  const ctx = await setup(t, { config: { max_volume: 60 } });
  const stale = { ...ctx.base, max_volume: 60 };
  const original = ctx.gladys.getConfig.bind(ctx.gladys);
  ctx.gladys.getConfig = async () => {
    await sleep(200);
    return stale;
  };
  const reconnect = ctx.app.connected();
  await sleep(50);
  await ctx.gladys.fake.configUpdated({ ...ctx.base, max_volume: 20 });
  assert.equal(ctx.app.config.maxVolume, 20);
  await reconnect;
  ctx.gladys.getConfig = original;
  assert.equal(ctx.app.config.maxVolume, 20);
});

test('review 3, A7: a reconnection overtaken by a save still republishes the status and states', async (t) => {
  const ctx = await setup(t);
  await sleep(100);
  const original = ctx.gladys.getConfig.bind(ctx.gladys);
  ctx.gladys.getConfig = async () => {
    await sleep(200);
    return { ...ctx.base, max_volume: 60 };
  };
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  let forgets = 0;
  const forget = ctx.gladys.forgetPublishedStates.bind(ctx.gladys);
  ctx.gladys.forgetPublishedStates = (...args) => {
    forgets += 1;
    return forget(...args);
  };
  const reconnect = ctx.app.connected();
  await sleep(50);
  await ctx.gladys.fake.configUpdated({ ...ctx.base, max_volume: 20 });
  await reconnect;
  ctx.gladys.getConfig = original;
  assert.equal(forgets, 1);
  assert.ok(ctx.gladys.fake.connectionStatuses.length > statuses, 'status republished');
  // The newest configuration is kept (A5).
  assert.equal(ctx.app.config.maxVolume, 20);
});

// --- M8: details ---------------------------------------------------------------------------

test('M8: the pending limit never refuses a Standby; a read answered by an error says so', async (t) => {
  const ctx = await setup(t, { deviceOptions: { queryErrors: ['m'] } });
  const ack = await ctx.set('mute');
  assert.match(ack.error, /Mute state: the amplifier answered an error, nothing sent/);
  ctx.fake.delays.i = 300;
  const waiting = [];
  for (let i = 0; i <= LIMITS.pending; i += 1) {
    waiting.push(ctx.link.query('i', 2_000).catch((err) => err));
  }
  const refused = await ctx.link.query('i', 2_000).catch((err) => err);
  assert.match(refused.message, /Too many commands waiting/);
  const standby = await ctx.set('standby');
  assert.equal(standby.success, true, standby.error);
  ctx.app.stop();
  await Promise.all(waiting);
});
