// -----------------------------------------------------------------------------
// HegelApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store and the fake Hegel amplifier on the
// loopback interface. The background round and the poll never fire by
// themselves: the tests drive them.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HegelApp, parseVolumeCommand } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { closedPort, startFakeHegel } from './fixtures/fakeHegel.js';

const SELECTOR = 'hegel';

/** No background round, no poll; real (short) timeouts. */
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
};

async function waitFor(predicate, what, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(t, { deviceOptions, config, devices, store, timings = {}, now } = {}) {
  const fake = await startFakeHegel(deviceOptions);
  t.after(() => fake.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ? config(fake) : { addresses: `127.0.0.1:${fake.port}` },
    devices: devices ? devices(fake) : [],
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const memory = store ? store(fake) : new MemoryStore();
  const app = new HegelApp({
    gladys,
    logger,
    store: memory,
    timers,
    timings: { ...FAST, ...timings },
    ...(now ? { now } : {}),
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  await gladys.connect();
  const id = (key) => `ext:${SELECTOR}:hegel:127.0.0.1_${fake.port}${key ? `:${key}` : ''}`;
  return { fake, gladys, app, logs, id, store: memory };
}

async function discovered({ gladys, id }) {
  await waitFor(
    () => gladys.fake.discoveredDevices.some((d) => d.external_id === id()),
    'the device in the Discovery tab',
  );
  return gladys.fake.discoveredDevices.find((d) => d.external_id === id());
}

async function createDevice(ctx) {
  const device = await discovered(ctx);
  await ctx.gladys.fake.deviceCreated(device);
  await waitFor(() => ctx.gladys.fake.lastState(ctx.id('power')) !== undefined, 'the power state');
  return device;
}

const set = ({ gladys, id }, device, key, value = 1) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === id(key)),
    value,
  );

test('a typed address becomes a Gladys device; its states once created', async (t) => {
  const ctx = await setup(t);
  const device = await discovered(ctx);
  assert.equal(device.name, `Hegel 127.0.0.1:${ctx.fake.port}`);
  assert.deepEqual(device.params, [{ name: 'IP_ADDRESS', value: '127.0.0.1' }]);
  const keys = device.features.map((f) => f.external_id.slice(ctx.id().length + 1));
  assert.deepEqual(keys, ['power', 'power_on', 'standby', 'volume', 'mute', 'input']);
  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  // No switch, nothing an "everything on / off" could command; the power is read only.
  assert.ok(device.features.every((f) => f.category !== 'switch'));
  assert.ok(device.features.filter((f) => f.type === 'binary').every((f) => f.read_only));
  assert.deepEqual([byKey.power.category, byKey.power.read_only], ['unknown', true]);
  assert.deepEqual([byKey.power_on.category, byKey.power_on.type], ['button', 'push']);
  assert.deepEqual([byKey.standby.category, byKey.standby.type], ['button', 'push']);
  assert.deepEqual(
    [byKey.volume.category, byKey.volume.type, byKey.volume.min, byKey.volume.max],
    ['music', 'volume', 0, 100],
  );
  assert.deepEqual([byKey.mute.category, byKey.mute.type], ['television', 'volume-mute']);
  assert.equal(byKey.volume.unit, undefined, 'no unit for the music category');
  assert.deepEqual(byKey.input.supported_options, [{ value: '1', label: 'Input 1' }]);
  assert.equal(ctx.gladys.fake.states.length, 0, 'no state before the device is created');

  await createDevice(ctx);
  await waitFor(() => ctx.gladys.fake.lastState(ctx.id('input')) === '1', 'the input');
  const last = (key) => ctx.gladys.fake.lastState(ctx.id(key));
  assert.equal(last('power'), 1);
  assert.equal(last('volume'), 30);
  assert.equal(last('mute'), 0);
  // Only queries, nothing set by the connection itself.
  assert.deepEqual(ctx.fake.commands(), []);
  assert.deepEqual(ctx.fake.received.slice(0, 4), ['-p.?', '-v.?', '-m.?', '-i.?']);
  assert.deepEqual(ctx.gladys.fake.connectionStatus, { connected: true });
});

test('pushed lines are published, grouped; a new input grows the dropdown', async (t) => {
  const ctx = await setup(t);
  await createDevice(ctx);
  ctx.fake.push('-v.55');
  ctx.fake.push('-m.1');
  ctx.fake.push('-i.4');
  ctx.fake.push('-p.0');
  await waitFor(() => ctx.gladys.fake.lastState(ctx.id('power')) === 0, 'power 0');
  assert.equal(ctx.gladys.fake.lastState(ctx.id('volume')), 55);
  assert.equal(ctx.gladys.fake.lastState(ctx.id('mute')), 1);
  await waitFor(() => ctx.gladys.fake.lastState(ctx.id('input')) === '4', 'input 4');
  const device = ctx.gladys.fake.discoveredDevices.find((d) => d.external_id === ctx.id());
  const input = device.features.find((f) => f.external_id === ctx.id('input'));
  assert.deepEqual(
    input.supported_options.map((o) => o.value),
    ['1', '4'],
  );
});

test('volume: capped by the option read just before sending; strict validation', async (t) => {
  const ctx = await setup(t);
  const device = await createDevice(ctx);
  assert.equal((await set(ctx, device, 'volume', 25)).success, true);
  assert.equal(ctx.fake.state.v, '25');
  // Default cap 40.
  assert.equal((await set(ctx, device, 'volume', 100)).success, true);
  assert.equal(ctx.fake.state.v, '40');
  assert.equal((await set(ctx, device, 'volume', '0')).success, true);
  assert.equal(ctx.fake.state.v, '0');
  await ctx.gladys.fake.configUpdated({ addresses: `127.0.0.1:${ctx.fake.port}`, max_volume: 20 });
  assert.equal((await set(ctx, device, 'volume', 30)).success, true);
  assert.equal(ctx.fake.state.v, '20');
  // A cap typed above the scale is brought back to 100.
  await ctx.gladys.fake.configUpdated({ addresses: `127.0.0.1:${ctx.fake.port}`, max_volume: 500 });
  assert.equal((await set(ctx, device, 'volume', 90)).success, true);
  assert.equal(ctx.fake.state.v, '90');
  const before = ctx.fake.commands().length;
  for (const bad of [null, '', true, 12.5, '12abc', -1, 101, NaN, '1e2']) {
    assert.equal((await set(ctx, device, 'volume', bad)).success, false, String(bad));
  }
  assert.equal(ctx.fake.commands().length, before, 'nothing sent for an invalid volume');
});

test('mute: the state read again decides; unmuting lowers a volume above the cap first', async (t) => {
  const ctx = await setup(t, { deviceOptions: { state: { m: '1', v: '80' } } });
  const device = await createDevice(ctx);
  assert.equal((await set(ctx, device, 'mute')).success, true);
  assert.deepEqual(ctx.fake.commands(), ['-v.40', '-m.0']);
  assert.equal((await set(ctx, device, 'mute')).success, true);
  assert.deepEqual(ctx.fake.commands().slice(2), ['-m.1']);
  // The amplifier does not answer the mute query: nothing sent.
  ctx.fake.unanswered.add('m');
  const ack = await set(ctx, device, 'mute');
  assert.equal(ack.success, false);
  assert.match(ack.error, /nothing sent/);
  assert.equal(ctx.fake.commands().length, 3);
});

test('power on brings an amplifier waking up loud back to the cap', async (t) => {
  const ctx = await setup(t, { deviceOptions: { state: { p: '0' }, wakeVolume: '90' } });
  const device = await createDevice(ctx);
  assert.equal(ctx.gladys.fake.lastState(ctx.id('power')), 0);
  const ack = await set(ctx, device, 'power_on');
  assert.equal(ack.success, true, ack.error);
  await waitFor(() => ctx.fake.commands().includes('-v.40'), 'the volume capped');
  assert.deepEqual(ctx.fake.commands(), ['-p.1', '-v.40']);
});

test('standby goes first, and cancels a power on still waiting', async (t) => {
  const ctx = await setup(t, { deviceOptions: { state: { p: '0' } } });
  const device = await createDevice(ctx);
  ctx.fake.delays.p = 250;
  const first = set(ctx, device, 'power_on');
  await settle(20);
  const second = set(ctx, device, 'power_on');
  await settle(20);
  const standby = set(ctx, device, 'standby');
  const [a, b, c] = await Promise.all([first, second, standby]);
  assert.equal(c.success, true);
  assert.equal(b.success, false);
  assert.match(b.error, /Cancelled by Standby, nothing sent/);
  assert.equal(a.success, true);
  const powers = ctx.fake.commands().filter((l) => l.startsWith('-p.'));
  assert.deepEqual(powers, ['-p.1', '-p.0']);
});

test('standby works before the first read of a just opened connection', async (t) => {
  const ctx = await setup(t, {
    // Under requestTimeout (300 ms): the first -p.? is still in flight when Standby is pressed.
    deviceOptions: { delays: { p: 200 } },
    config: () => ({ addresses: '' }),
    devices: (fake) => {
      const ext = `ext:${SELECTOR}:hegel:127.0.0.1_${fake.port}`;
      return [{ name: 'Hegel', external_id: ext, features: [] }];
    },
  });
  await waitFor(() => ctx.fake.received.includes('-p.?'), 'the first query');
  const link = [...ctx.app.links.values()][0];
  assert.equal(link.connected, false);
  const device = {
    external_id: ctx.id(),
    features: [{ external_id: ctx.id('standby') }],
  };
  const ack = await set(ctx, device, 'standby');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.fake.commands(), ['-p.0']);
});

test('input: only the options, sent as the amplifier value', async (t) => {
  const ctx = await setup(t, {
    config: (fake) => ({ addresses: `127.0.0.1:${fake.port}`, input_names: '1=Balanced, 9=USB' }),
  });
  const device = await createDevice(ctx);
  const input = device.features.find((f) => f.external_id === ctx.id('input'));
  assert.deepEqual(input.supported_options, [
    { value: '1', label: 'Balanced' },
    { value: '9', label: 'USB' },
  ]);
  assert.equal((await set(ctx, device, 'input', '9')).success, true);
  assert.deepEqual(ctx.fake.commands(), ['-i.9']);
  for (const bad of ['3', '1\r-p.0', 9, '', '09']) {
    assert.equal((await set(ctx, device, 'input', bad)).success, false, JSON.stringify(bad));
  }
  assert.equal(ctx.fake.commands().length, 1);
  assert.equal((await set(ctx, device, 'power', 1)).success, false, 'the power is read only');
});

test('a command without answer is "sent, without confirmation", within the budget', async (t) => {
  const ctx = await setup(t, { timings: { commandBudget: 400 } });
  const device = await createDevice(ctx);
  ctx.fake.unanswered.add('v');
  const started = Date.now();
  const ack = await set(ctx, device, 'volume', 10);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent, without confirmation/);
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(ctx.fake.commands(), ['-v.10']);
});

test('an error line is "sent, without confirmation", never "nothing done"', async (t) => {
  const ctx = await setup(t, { deviceOptions: { errors: ['i'] } });
  const device = await createDevice(ctx);
  const ack = await set(ctx, device, 'input', '1');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent, without confirmation: the amplifier answered an error \(3\)/);
});

test('an amplifier that is not connected: nothing sent, standby included; power 0 and named', async (t) => {
  const ctx = await setup(t);
  const device = await createDevice(ctx);
  await ctx.fake.close();
  await waitFor(() => ctx.gladys.fake.lastState(ctx.id('power')) === 0, 'power 0');
  const ack = await set(ctx, device, 'standby');
  assert.equal(ack.success, false);
  assert.match(ack.error, /not connected .*nothing sent/);
  await waitFor(
    () => /Not connected/.test(ctx.gladys.fake.connectionStatus?.message?.en ?? ''),
    'the status message',
  );
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('an address where nothing answers, or not a Hegel amplifier, is named in the status', async (t) => {
  const port = await closedPort();
  const ctx = await setup(t, {
    deviceOptions: { silent: true },
    config: (fake) => ({ addresses: `127.0.0.1:${port}, 127.0.0.1:${fake.port}, 1.2.3` }),
  });
  await waitFor(
    () =>
      new RegExp(`answers yet at: .*127\\.0\\.0\\.1:${ctx.fake.port}`).test(
        ctx.gladys.fake.connectionStatus?.message?.en ?? '',
      ) && ctx.gladys.fake.connectionStatus.message.en.includes(`127.0.0.1:${port}`),
    'the status',
  );
  const { en, fr } = ctx.gladys.fake.connectionStatus.message;
  assert.match(en, /Ignored in the configuration \(invalid\): 1\.2\.3/);
  assert.match(fr, /Aucun ampli Hegel ne répond/);
  assert.deepEqual(ctx.gladys.fake.discoveredDevices, []);
});

test('a flood or an endless line closes the connection, reconnected spaced out', async (t) => {
  const ctx = await setup(t);
  await createDevice(ctx);
  ctx.fake.write('x'.repeat(10_000));
  ctx.fake.write('\r-v.12\r');
  await waitFor(() => ctx.gladys.fake.lastState(ctx.id('volume')) === 12, 'the next line read');
  const connections = ctx.fake.connections;
  ctx.fake.write('-p.1\r'.repeat(400));
  await waitFor(() => ctx.fake.connections > connections, 'a new connection');
  assert.ok(ctx.logs.some((l) => /too many lines/.test(l)));
});

test('a created device unknown to /data is found again from its external id', async (t) => {
  const ctx = await setup(t, {
    config: () => ({ addresses: '' }),
    devices: (fake) => {
      const ext = `ext:${SELECTOR}:hegel:127.0.0.1_${fake.port}`;
      return [
        {
          name: 'Hegel H190',
          external_id: ext,
          features: [
            {
              external_id: `${ext}:input`,
              supported_options: [
                { value: '1', label: 'Balanced' },
                { value: '7', label: 'Optical 3' },
              ],
            },
          ],
        },
      ];
    },
  });
  await waitFor(() => ctx.gladys.fake.lastState(ctx.id('power')) === 1, 'the power state');
  const device = await discovered(ctx);
  const input = device.features.find((f) => f.external_id === ctx.id('input'));
  assert.deepEqual(input.supported_options, [
    { value: '1', label: 'Balanced' },
    { value: '7', label: 'Optical 3' },
  ]);
});

test('a reconnection to Gladys republishes the status and the devices, never asks faster', async (t) => {
  const ctx = await setup(t);
  await createDevice(ctx);
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  const discoveries = ctx.gladys.fake.bodies('POST', '/discovered_device').length;
  const connections = ctx.fake.connections;
  const received = ctx.fake.received.length;
  await ctx.app.start({ addresses: `127.0.0.1:${ctx.fake.port}` }, { connected: true });
  assert.equal(ctx.gladys.fake.connectionStatuses.length, statuses + 1);
  assert.ok(ctx.gladys.fake.bodies('POST', '/discovered_device').length > discoveries);
  await settle(60);
  assert.equal(ctx.fake.connections, connections, 'the link is kept');
  assert.equal(ctx.fake.received.length, received, 'nothing asked again');
});

test('the time of each attempt is saved before it; a restart never asks sooner', async (t) => {
  const port = await closedPort();
  const id = `127.0.0.1_${port}`;
  let store;
  const ctx = await setup(t, {
    config: () => ({ addresses: `127.0.0.1:${port}` }),
    store: () => {
      store = new MemoryStore();
      return store;
    },
  });
  await waitFor(() => Number.isFinite(store.data.attempts?.[id]), 'the attempt saved');
  // Several failed attempts within attemptSaveEvery: one write.
  await settle(150);
  assert.ok(ctx.app.links.values().next().value.failures >= 2);
  const saved = store.data.attempts[id];
  assert.ok(Date.now() - saved < 300);

  // A restart right after: the amplifier is not asked before attemptSaveEvery.
  const fake = await startFakeHegel();
  t.after(() => fake.close());
  const restarted = new MemoryStore({
    devices: {},
    attempts: { [`127.0.0.1_${fake.port}`]: Date.now() },
  });
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { addresses: `127.0.0.1:${fake.port}` },
  });
  const app = new HegelApp({
    gladys,
    store: restarted,
    timers,
    timings: FAST,
    logger: ctx.app.logger,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  await gladys.connect();
  await settle(150);
  assert.equal(fake.connections, 0, 'not asked within the interval');
  await waitFor(() => fake.connections === 1, 'asked after the interval');
});

test('the poll reads the states again; two silent polls close the connection', async (t) => {
  const ctx = await setup(t);
  await createDevice(ctx);
  const link = [...ctx.app.links.values()][0];
  ctx.fake.state.v = '5';
  await link.poll();
  await waitFor(() => ctx.gladys.fake.lastState(ctx.id('volume')) === 5, 'the polled volume');
  const connections = ctx.fake.connections;
  ctx.fake.silent = true;
  await link.poll();
  assert.equal(link.open, true);
  await link.poll();
  ctx.fake.silent = false;
  await waitFor(() => ctx.fake.connections > connections, 'a new connection');
});

test('check the devices, from memory only', async (t) => {
  const ctx = await setup(t);
  await createDevice(ctx);
  const received = ctx.fake.received.length;
  const ack = await ctx.gladys.fake.action('check_devices');
  assert.equal(ack.success, true);
  assert.match(
    ack.data.message.en,
    /Hegel 127\.0\.0\.1:\d+: connected, on, volume 30, not muted, input 1/,
  );
  assert.match(ack.data.message.en, /Volume cap: 40/);
  assert.match(ack.data.message.fr, /Plafond de volume : 40/);
  assert.equal(ctx.fake.received.length, received, 'the button asks nothing');
});

// --- Hostile scenarios (lessons of the NAD and Cambridge Audio reviews) ---------------

test('S1: a Standby pressed after a Power on waiting behind a poll query wins', async (t) => {
  const ctx = await setup(t, { deviceOptions: { state: { p: '0' }, quietWhenOff: true } });
  const device = await createDevice(ctx);
  const link = [...ctx.app.links.values()][0];
  // In standby only -p is answered: the poll's -v.? stays in flight.
  const poll = link.poll();
  await waitFor(() => ctx.fake.received.at(-1) === '-v.?', 'the poll volume query');
  const on = set(ctx, device, 'power_on');
  await settle(20);
  const off = set(ctx, device, 'standby');
  const [a, b] = await Promise.all([on, off]);
  await poll;
  await settle(100);
  assert.equal(b.success, true);
  assert.equal(a.success, false);
  assert.match(a.error, /Cancelled by Standby, nothing sent/);
  assert.deepEqual(ctx.fake.commands(), ['-p.0']);
  assert.equal(ctx.fake.state.p, '0');
});

test('S2: a late answer of another value never confirms a volume command', async (t) => {
  const ctx = await setup(t, {
    deviceOptions: { delays: { v: 400 } },
    timings: { commandBudget: 700 },
  });
  const device = await createDevice(ctx);
  const link = [...ctx.app.links.values()][0];
  const poll = link.poll();
  await waitFor(() => ctx.fake.received.at(-1) === '-v.?', 'the poll volume query');
  await settle(320);
  // The amplifier now ignores the command; the late "-v.30" is still on its way.
  ctx.fake.unanswered.add('v');
  const ack = await set(ctx, device, 'volume', 20);
  await poll;
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent, without confirmation/);
  assert.equal(ctx.fake.state.v, '30');
});

test('S3: a contradicting answer (-p.1) never confirms Standby', async (t) => {
  const ctx = await setup(t, {
    deviceOptions: { ignoreSet: ['p'] },
    timings: { commandBudget: 600 },
  });
  const device = await createDevice(ctx);
  const ack = await set(ctx, device, 'standby');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent, without confirmation/);
  assert.equal(ctx.gladys.fake.lastState(ctx.id('power')), 1);
});

test('S4: unmute is refused when the amplifier does not lower its volume to the cap', async (t) => {
  const ctx = await setup(t, {
    deviceOptions: { state: { m: '1', v: '80' }, ignoreSet: ['v'] },
    timings: { commandBudget: 800 },
  });
  const device = await createDevice(ctx);
  const ack = await set(ctx, device, 'mute');
  assert.equal(ack.success, false);
  assert.match(ack.error, /volume not lowered to the cap .*mute kept/);
  assert.deepEqual(ctx.fake.commands(), ['-v.40']);
  assert.equal(ctx.fake.state.m, '1');
});

test('S5: after a wake-up, an unconfirmed lowering keeps the checks going', async (t) => {
  const ctx = await setup(t, {
    deviceOptions: { state: { p: '0' }, wakeVolume: '90', ignoreSet: ['v'] },
    timings: { preRead: 150, requestTimeout: 150 },
  });
  const device = await createDevice(ctx);
  assert.equal((await set(ctx, device, 'power_on')).success, true);
  await waitFor(
    () => ctx.logs.some((l) => /volume not confirmed after waking up/.test(l)),
    'the end of the checks',
    6_000,
  );
  const lowerings = ctx.fake.commands().filter((l) => l === '-v.40').length;
  assert.ok(lowerings >= 3, `${lowerings} lowerings`);
  assert.equal(ctx.app.wakeChecks.size, 0);
});

test('a volume pushed above the cap just after a wake-up is lowered', async (t) => {
  const ctx = await setup(t, {
    deviceOptions: { state: { p: '0' } },
    timings: { wakeCheckDelay: 200 },
  });
  const device = await createDevice(ctx);
  assert.equal((await set(ctx, device, 'power_on')).success, true);
  assert.deepEqual(ctx.fake.commands(), ['-p.1']);
  ctx.fake.state.v = '95';
  ctx.fake.push('-v.95');
  await waitFor(() => ctx.fake.commands().includes('-v.40'), 'the volume lowered');
  assert.equal(ctx.fake.state.v, '40');
});

test('the publication delay grows with the number of created devices', async (t) => {
  const ctx = await setup(t);
  await createDevice(ctx);
  const delays = [];
  const original = ctx.app.timers;
  ctx.app.timers = {
    ...original,
    setTimeout: (fn, ms) => {
      delays.push(ms);
      return original.setTimeout(fn, ms);
    },
  };
  ctx.app.created = new Set(['a', 'b', 'c']);
  ctx.app.schedulePublish('a');
  ctx.app.timers = original;
  assert.deepEqual(delays, [FAST.publishDelay * 3]);
});

test('a late event of a replaced link publishes nothing', async (t) => {
  const ctx = await setup(t);
  await createDevice(ctx);
  const link = [...ctx.app.links.values()][0];
  ctx.app.links.clear();
  link.state = { ...link.state, volume: 3 };
  const states = ctx.gladys.fake.states.length;
  ctx.app.linkEvent('update', link, 'v');
  await settle(30);
  link.stop();
  assert.equal(ctx.gladys.fake.states.length, states);
});

test('parseVolumeCommand', () => {
  assert.equal(parseVolumeCommand(0), 0);
  assert.equal(parseVolumeCommand(' 42 '), 42);
  for (const bad of [null, undefined, '', true, 12.5, '12abc', -1, 101, NaN, {}]) {
    assert.equal(parseVolumeCommand(bad), undefined, String(bad));
  }
});
