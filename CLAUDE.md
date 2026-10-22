# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Hegel amplifiers, over their
IP control port (Hegel ASCII protocol on TCP, port 50001): a Node.js service
(Node 22+, ESM, no build step) that runs in its own sandboxed Docker container
and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template;
the protocol is ported from the `hegel-ip-client` Python library (MIT, see
`THIRD_PARTY_NOTICES.md`). Decisions are recorded in `TODO.md`.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "volume"  # tests whose name matches
npm run cover                             # regenerates cover.png
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/handlers.js                   every SDK handler -> HegelApp (shared with the tests)
src/app.js                        devices, links, commands and volume cap, button, status
src/hegel/link.js                 one address: TCP connection, snapshot, pushed lines, poll, reconnection
src/hegel/protocol.js             commands, lines, values (pure, untrusted input)
src/model.js                      devices -> Gladys devices and states (pure)
src/store.js                      /data/hegel.json
src/constants.js                  frozen keys, limits, timings
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, fake Gladys + fake Hegel amplifier (test/fixtures/)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds('hegel', addressId(address))`: the protocol gives no
  serial number, so the address is the identity (`<host>`, or `<host>_<port>`
  when not 50001). Gladys keys devices, their history, scenes and dashboards
  on them. The same goes for every key users store: manifest `config_schema`,
  `actions`, feature keys.
- **The volume cap is a safety rule.** Every volume sent goes through the cap
  read just before sending (`Math.min(value, config.maxVolume)`); never add a
  path (scene action, widget, volume up) that bypasses it.
- **No switch** for power: an "everything on / off" must not command an
  amplifier. Buttons and read-only states only. Standby is never blocked by
  the other commands.
- **Nothing but a validated value is written to the amplifier**
  (`encode` refuses anything but the known letters and their exact values).
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set once by hand, see `TODO.md`).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM, without control bytes (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never leave the loopback interface.
