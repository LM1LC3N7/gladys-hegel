// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, never mojibake
// (UTF-8 bytes read as Latin-1 / Windows-1252 and saved again: "é" becoming
// "Ã" + "©"), and hold no control byte. And no text claims that something is
// encrypted: the integration keeps no secret, and Gladys stores the
// configuration in clear in its database.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const MOJIBAKE = /[ÂÃ][\u0080-¿€]|â€/;
const ENCRYPTED = /chiffr|crypt|encrypt/i;
// Control characters other than tab, line feed and carriage return.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const listJs = (dir) =>
  readdirSync(new URL(`../${dir}`, import.meta.url), { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => `${dir}/${String(f).replaceAll('\\', '/')}`);

const TEXTS = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'package.json',
  'Dockerfile',
  'index.js',
  'scripts/cover.mjs',
];
// This file holds the patterns themselves (mojibake samples): left out.
const FILES = [...TEXTS, ...listJs('src'), ...listJs('test')].filter(
  (f) => f !== 'test/encoding.test.js',
);

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake, no control byte`, () => {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const lines = text.split('\n');
    const mojibake = lines.findIndex((l) => MOJIBAKE.test(l));
    assert.equal(mojibake, -1, `mojibake on line ${mojibake + 1}`);
    const control = lines.findIndex((l) => CONTROL.test(l));
    assert.equal(control, -1, `control byte on line ${control + 1}`);
  });
}

for (const file of [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'src/i18n.js',
]) {
  test(`${file}: never says "encrypted"`, () => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const line = text.split('\n').findIndex((l) => ENCRYPTED.test(l));
    assert.equal(line, -1, `"encrypted" on line ${line + 1}`);
  });
}

test('the patterns catch what they should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Â«', MOJIBAKE, '« read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app…', MOJIBAKE);
  assert.match('stocké chiffré', ENCRYPTED);
  assert.match('stored encrypted', ENCRYPTED);
  assert.match('a\u0007b', CONTROL);
  assert.doesNotMatch('a\tb\r', CONTROL);
});

test('LICENSE names nobody', () => {
  const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Copyright (?:\(c\) )?\d{4}/i);
});
