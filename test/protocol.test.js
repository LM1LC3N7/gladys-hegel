import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYS,
  LineSplitter,
  applyLine,
  cleanText,
  confirmsSet,
  encode,
  isInputValue,
  parseFlag,
  parseInput,
  parseLine,
  parseVolume,
} from '../src/hegel/protocol.js';

test('commands: `-<key>.?\\r` and `-<key>.<value>\\r`, never another line', () => {
  assert.equal(encode(KEYS.POWER, '?').toString('latin1'), '-p.?\r');
  assert.equal(encode(KEYS.VOLUME, '=', '40').toString('latin1'), '-v.40\r');
  assert.equal(encode(KEYS.INPUT, '=', '12').toString('latin1'), '-i.12\r');
  assert.equal(encode(KEYS.MUTE, '=', '1').toString('latin1'), '-m.1\r');
  for (const [key, bad] of [
    [KEYS.INPUT, '1\r-p.0'],
    [KEYS.INPUT, '0'],
    [KEYS.INPUT, '21'],
    [KEYS.INPUT, '01'],
    [KEYS.VOLUME, '101'],
    [KEYS.VOLUME, '-1'],
    [KEYS.VOLUME, 'u'],
    [KEYS.POWER, 't'],
    [KEYS.POWER, '2'],
    [KEYS.MUTE, undefined],
    [KEYS.VOLUME, 40],
  ]) {
    assert.throws(() => encode(key, '=', bad), /Invalid/, `${key} ${String(bad)}`);
  }
  assert.throws(() => encode('r', '?'), /Unknown Hegel key/);
  assert.throws(() => encode('__proto__', '?'), /Unknown Hegel key/);
  assert.throws(() => encode(KEYS.POWER, '+'), /Invalid/);
});

test('lines: anchored, bounded, key lowercased', () => {
  assert.deepEqual(parseLine('-p.1'), { key: 'p', value: '1' });
  assert.deepEqual(parseLine(' -V.100 '), { key: 'v', value: '100' });
  assert.deepEqual(parseLine('-e.3'), { key: 'e', value: '3' });
  assert.deepEqual(parseLine('-r.~'), { key: 'r', value: '~' });
  for (const bad of [
    '',
    '-p',
    'p.1',
    '-p.',
    '--p.1',
    '-p.1x2zz',
    '-p.\u0007',
    `-v.${'1'.repeat(20)}`,
  ]) {
    assert.equal(parseLine(bad), undefined, JSON.stringify(bad));
  }
});

test('a command is confirmed only by the value it asked', () => {
  assert.equal(confirmsSet(KEYS.POWER, '0', '0'), true);
  assert.equal(confirmsSet(KEYS.POWER, '0', '1'), false);
  assert.equal(confirmsSet(KEYS.MUTE, '1', '?'), false);
  assert.equal(confirmsSet(KEYS.VOLUME, '40', '40'), true);
  assert.equal(confirmsSet(KEYS.VOLUME, '40', '41'), false);
  assert.equal(confirmsSet(KEYS.VOLUME, '40', 'junk'), false);
  assert.equal(confirmsSet(KEYS.INPUT, '3', '3'), true);
  assert.equal(confirmsSet(KEYS.INPUT, '2', '1'), false);
  assert.equal(confirmsSet('e', '1', '1'), false);
});

test('values', () => {
  assert.equal(parseFlag('1'), true);
  assert.equal(parseFlag('0'), false);
  assert.equal(parseFlag('t'), undefined);
  assert.equal(parseVolume('0'), 0);
  assert.equal(parseVolume('100'), 100);
  for (const bad of ['', '101', '-1', '05', '1e2', 'u', '50.5', undefined]) {
    assert.equal(parseVolume(bad), undefined, String(bad));
  }
  assert.equal(parseInput('7'), '7');
  assert.equal(parseInput('07'), '7');
  for (const bad of ['0', '21', 'x', '', '123']) {
    assert.equal(parseInput(bad), undefined, bad);
  }
  assert.equal(isInputValue('20'), true);
  assert.equal(isInputValue('a\rb'), false);
  assert.equal(cleanText('‮USB\u0000 '), 'USB');
  assert.equal(cleanText('   '), undefined);
});

test('applyLine: known keys only, the same object when nothing changed', () => {
  const s0 = {};
  const s1 = applyLine(s0, { key: 'p', value: '1' });
  assert.equal(s1.power, true);
  assert.equal(applyLine(s1, { key: 'p', value: '1' }), s1);
  assert.equal(applyLine(s1, { key: 'r', value: '~' }), s1);
  assert.equal(applyLine(s1, { key: 'e', value: '1' }), s1);
  assert.equal(applyLine(s1, { key: 'v', value: '35' }).volume, 35);
  assert.equal(applyLine(s1, { key: 'v', value: 'u' }).volume, undefined);
  assert.equal(applyLine(s1, { key: 'i', value: '4' }).input, '4');
  assert.equal(applyLine(s1, { key: 'm', value: '1' }).mute, true);
  assert.equal({}.polluted, undefined);
});

test('lines split on CR or LF; an endless line is dropped up to its end', () => {
  const splitter = new LineSplitter(10);
  assert.deepEqual(splitter.push('-p.1\r\n-v.'), ['-p.1']);
  assert.deepEqual(splitter.push('40\r'), ['-v.40']);
  assert.deepEqual(splitter.push('x'.repeat(8)), []);
  assert.deepEqual(splitter.push('y'.repeat(8)), []);
  assert.deepEqual(splitter.push('zz\r-m.0\r'), ['-m.0']);
});
