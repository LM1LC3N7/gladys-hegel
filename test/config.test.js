import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  addressId,
  normalizeConfig,
  parseAddress,
  parseInputNames,
  parseMaxVolume,
} from '../src/config.js';
import { MAX_VOLUME } from '../src/constants.js';
import { sanitizeData } from '../src/store.js';

test('addresses: IPv4 or host name, port 50001 by default', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), { host: '192.168.1.50', port: 50001 });
  assert.deepEqual(parseAddress('tcp://192.168.1.50:5000/'), { host: '192.168.1.50', port: 5000 });
  assert.deepEqual(parseAddress('Hegel-H190.local'), { host: 'hegel-h190.local', port: 50001 });
  for (const bad of [
    '',
    '999.1.1.1',
    '1.2.3',
    'a b',
    'host:0',
    'host:70000',
    '-x.local',
    'a_b',
    null,
  ]) {
    assert.equal(parseAddress(bad), undefined, String(bad));
  }
  assert.equal(addressId({ host: '192.168.1.50', port: 50001 }), '192.168.1.50');
  assert.equal(addressId({ host: 'amp', port: 5000 }), 'amp_5000');
});

test('the volume cap: an integer 1..100, 40 by default', () => {
  assert.equal(DEFAULT_CONFIG.max_volume, MAX_VOLUME.default);
  assert.equal(MAX_VOLUME.default, 40);
  assert.equal(parseMaxVolume(35), 35);
  assert.equal(parseMaxVolume('60'), 60);
  assert.equal(parseMaxVolume(500), 100);
  assert.equal(parseMaxVolume(0), 1);
  assert.equal(parseMaxVolume(-20), 1);
  assert.equal(parseMaxVolume(20.4), 20);
  for (const bad of [null, undefined, '', ' ', 'abc', true, NaN, {}]) {
    assert.equal(parseMaxVolume(bad), 40, String(bad));
  }
});

test('input names', () => {
  assert.deepEqual(parseInputNames('1=Balanced, 2 = Analog 1;9=USB,1=Again'), {
    options: [
      { value: '1', label: 'Balanced' },
      { value: '2', label: 'Analog 1' },
      { value: '9', label: 'USB' },
    ],
    invalid: [],
  });
  assert.deepEqual(parseInputNames('CD, a b=x, 4=, 0=Zero, 21=Too far').invalid, [
    'CD',
    'a b=x',
    '4=',
    '0=Zero',
    '21=Too far',
  ]);
});

test('normalizeConfig', () => {
  const config = normalizeConfig({
    addresses: '192.168.1.50, 192.168.1.50;192.168.1.51:50001 nope!',
    max_volume: '30',
  });
  assert.deepEqual(
    config.addresses.map((a) => a.host),
    ['192.168.1.50', '192.168.1.51'],
  );
  assert.deepEqual(config.invalid, ['nope!']);
  assert.equal(config.maxVolume, 30);
  assert.deepEqual(normalizeConfig().addresses, []);
  assert.equal(normalizeConfig().maxVolume, 40);
  assert.equal(normalizeConfig({ max_volume: null }).maxVolume, 40);
});

test('/data: only devices keyed by the id of their own address, no prototype', () => {
  const data = sanitizeData({
    devices: {
      '192.168.1.50': { id: '192.168.1.50', inputOptions: [{ value: '3', label: 'USB' }] },
      amp_5000: { id: 'amp_5000', inputOptions: [{ value: 'x y' }, { value: '25' }] },
      wrong: { id: 'other' },
      a_b_c: { id: 'a_b_c' },
      constructor: { id: 'constructor' },
    },
    attempts: { '192.168.1.50': 1_700_000_000_000, bad_id_x: 1, amp_5000: 'soon', __proto__: 5 },
  });
  assert.equal(Object.getPrototypeOf(data.devices), null);
  assert.equal(Object.getPrototypeOf(data.attempts), null);
  assert.deepEqual(Object.keys(data.devices), ['192.168.1.50', 'amp_5000', 'constructor']);
  assert.deepEqual(data.devices['192.168.1.50'], {
    id: '192.168.1.50',
    host: '192.168.1.50',
    port: 50001,
    inputOptions: [{ value: '3', label: 'USB' }],
  });
  assert.deepEqual(data.devices.amp_5000.port, 5000);
  assert.deepEqual(data.devices.amp_5000.inputOptions, []);
  assert.deepEqual({ ...data.attempts }, { '192.168.1.50': 1_700_000_000_000 });
  assert.deepEqual(sanitizeData('junk').devices, Object.create(null));
  assert.equal({}.polluted, undefined);
});
