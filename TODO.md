# TODO — Hegel v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local control** (2026-10-22): amplifiers added by IP
      address (port 50001 by default), one persistent TCP connection per
      address with pushed lines, a poll a minute and spaced reconnection (last
      attempt kept in /data); power state, power on, standby, volume capped by
      an option, mute, input dropdown; "Check" button; docs en/fr. Tested
      against a fake amplifier on the loopback interface only, never with a
      real one. The store validator could not be run from the development
      session (no access to it there): to run before the first release.
- [ ] **Milestone 2 — real amplifiers** (testers with an H95, H120, H190,
      H390, H590 or Röst). To check first:
  - whether IP control must be enabled in a menu, and whether the amplifier
    answers in standby (all letters, or only `-p`);
  - whether it accepts more than one client at a time;
  - the answers: `-p.1` after `-p.1`, the volume scale (0..100 on every
    model?), what `-e.N` means per N, unsolicited lines (`-r.*`);
  - the start-up volume after `-p.1`, and how long the amplifier takes to
    answer after waking up;
  - the input numbers per model (to offer named defaults per model);
  - the rendering on the Gladys dashboard (not checked here): the
    `television/volume-mute` press, the two `button/push`, the
    `unknown/binary` power and the `text/select` input.
- [ ] **Milestone 3 — more**: input names per model (if the model can be
      read), volume up/down buttons (still capped by reading the volume back).
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: boazca/hegel-ip-client 0.1.4 (MIT, 2025-12-27, the library of the
  Home Assistant Hegel integration; its LICENSE names no holder, only "2024")
  is Python, so its protocol (`-<letter>.<value>\r`, `?` queries, answers and
  pushed changes of the same form, one FIFO of pending replies), command
  letters and parsing are ported to JavaScript (`src/hegel/`); MIT notice in
  `THIRD_PARTY_NOTICES.md`, copied into the image. Its `-v.u` / `-v.d` (steps)
  and `-r` (reset) are not used. No runtime dependency besides the SDK
  (`node:net`). No Bluetooth, no serial port.
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1. The
  manifest test never pins a version (shape and agreement only).
- Identity (frozen rule): the protocol gives no serial number nor model, so
  the platform id is the address: `gladys.externalIds('hegel', '<host>')`,
  `<host>_<port>` when the port is not 50001 (`_` never appears in a host
  name: two addresses never share an id). The docs ask for a fixed IP address.
  The device name is `Hegel <host>[:port]` (Gladys lets the user rename it).
  A created device unknown to `/data` (file reset) is found again from its
  external id, and its input options from the created device. A known device
  that is neither typed nor created is forgotten (not when the created devices
  could not be read). No identity can be checked again before a command: the
  connection to the typed address is the identity, and `-p.?` must be answered
  as a Hegel amplifier does on every new connection.
- Feature keys are frozen: `power`, `power_on`, `standby`, `volume`, `mute`,
  `input`. Every publication carries the full, fixed feature list; only the
  input options grow (merged with the `supported_options` of the created
  device, sorted by number).
- **Power: read-only state + two `button/push` ("Power on", "Standby"), not a
  `switch`** (lesson of lot 6). `-p.1` / `-p.0`. Power 0 also when the
  amplifier does not answer after a failed connection attempt, not on a
  simple drop. Standby on an amplifier whose connection is not open is an
  error ("nothing sent"), never a success.
- **Standby is protective, never blocked**: it skips the device queue, goes
  first on the connection (after the one exchange already written), cancels a
  Power on still queued and the volume checks after a wake-up; a Power on
  whose line still waits on the connection is dropped right before the write
  (`shouldSend`, "Cancelled by Standby, nothing sent"). It only needs an open
  connection, not the first read (lesson of lot 11: stop possible before the
  first read): during the snapshot of a new connection it goes before the
  next query. No rate pause exists here (local, no 429), so nothing can block
  it.
- **Volume cap** (brief: "volume plafonné par option"): Hegel counts 0..100,
  as its display; Gladys shows the same value (`music/volume` 0..100, frozen
  at creation). `max_volume` (1..100, 40 by default) caps every command:
  `Math.min(value, cap)` with the cap read inside the queued task, just before
  the line leaves; a command above it sets the cap and succeeds (logged).
  Chosen over a percent mapping (as gladys-nad does in dB) because the Hegel
  scale is already 0..100: what Gladys shows is what the amplifier shows. A
  volume set on the amplifier itself above the cap is not lowered, except by
  the two commands of Gladys that would make it heard (as gladys-nad): unmute
  (the volume read again first; above the cap, `-v.<cap>` then `-m.0`;
  unknown: refused, nothing sent; lowering not confirmed: mute kept) and Power
  on (power and volume read again after the wake-up, lowered when above; when
  the amplifier cannot tell yet, checked again every 2.5 s, 6 times at most,
  through the device queue; a volume pushed above the cap during that window
  is lowered too; Standby ends the window; the ack of Power on never depends
  on it).
- Volume validated strictly before queueing: an integer 0..100 as a number or
  a string of digits; null, '', booleans, 12.5, '12abc', NaN refused.
- Mute is a push (Gladys sends a press, not a target): `-m.?` read again just
  before (1.5 s at most) and the explicit `-m.0` / `-m.1` sent, never the
  toggle `-m.t`. Unknown mute state: nothing sent.
- Input: the protocol gives a number (1..20 accepted), no name. The options:
  names typed in `input_names` (`1=Balanced, 9=Network`, override), then any
  input value seen ("Input N"). No default per model in v1: the numbering
  differs per model and was not verified.
- Commands: serialized per device (mute goes before the commands waiting),
  budget 3.5 s from the Gladys request, the waits included; each exchange
  bounded by what is left; a command still queued at its deadline is dropped,
  never sent late. The ack never waits for a publication to Gladys. A line
  that may have reached the amplifier (written, then no answer, connection
  closed, or an `-e.N` line) is answered "sent, without confirmation"; an
  amplifier not connected gets "nothing sent". A command is confirmed only by
  a line carrying the value asked (`confirmsSet`); any other line of the
  letter is a state.
- Error lines: `-e.<n>` carries no letter, and the protocol has no request id,
  so it may answer the line in flight or a late one: it ends the exchange in
  flight as "sent, without confirmation (the amplifier answered an error)",
  never "nothing done". During the snapshot, a query answered by an error
  leaves that state unknown.
- Connection: one TCP connection per typed address and per created device,
  kept across reconnections to Gladys (`connected` only clears the status
  cache and `forgetPublishedStates`, then republishes the status, the devices
  and the states; it never asks an amplifier again). `-p.?` must be answered
  `-p.0`/`-p.1` within 1.5 s, else "not a Hegel amplifier" and the connection
  is closed. Reconnection after 10 s, doubled after each failure up to 5
  minutes; the count is only reset by a connection that stayed up 60 s. A
  configuration save or a Discovery scan asks for a reconnection, never
  sooner than 10 s after the last attempt. One attempt at a time per link (a
  retry asked during an attempt starts nothing). A poll every 60 s (`-p.?`,
  then volume, mute, input), one query at a time; two polls in a row without
  an answer close the connection. TCP keep-alive at 30 s.
- Restarts (lesson of lots 11 and 12): the time of each connection attempt is
  written to `/data/hegel.json` **before** the attempt, at most once a minute
  per address; a restarted container does not ask an address before a minute
  after the saved time (`notBefore`, also applied to a retry asked
  meanwhile). A crash loop therefore asks an amplifier at most once a minute.
  Saves are serialized (one write at a time). Entries of addresses no longer
  wanted are dropped.
- Late events: a link replaced or stopped (configuration changed) publishes
  nothing (`links.get(key) === link` and `started` checked); the grouped
  publications check the app generation; a status published by a stopped
  generation is not remembered as published.
- Hostile input: lines cut on CR or LF, 64 characters at most (a longer one is
  dropped up to its end, never kept growing), decoded as Latin-1, one anchored
  expression per line (`-<letter>.<1..4 characters>`), only the known letters
  applied, values parsed strictly (0/1, 0..100 digits, input 1..20). More than
  300 lines in 10 s closes the connection. 16 exchanges waiting at most, 20
  devices, 20 addresses, 20 inputs. The tables of `/data` have no prototype
  and keep an entry only under the id of its own valid address. No control
  byte in any file (test).
- Discovery: no network capture in the manifest; Hegel amplifiers announce
  nothing usable for this protocol (their AirPlay / UPnP services are other
  APIs). The Discovery scan button republishes the typed devices and asks the
  silent addresses again (never sooner than the base interval).
- "Check the amplifiers" answers from memory only: it never asks an amplifier
  faster.
- Publication: grouped per device (at most one `publishChangedStates` per
  `publishDelay` × the number of created devices, 4 states at most: under 300
  states a minute in total), only the created devices, never undefined nor
  NaN. No `publishSceneEvent`, no energy index.
- Categories and types from the core only (`server/utils/constants.js`):
  `music/volume` (as the core Sonos service), `television/volume-mute` (music
  has no mute type), `text/select`, `button/push`, `unknown/binary`. No unit:
  `DEVICE_FEATURE_UNITS_BY_CATEGORY` lists none for music, television, text,
  button or unknown. Store category `multimedia`.
- No secret anywhere: the Hegel control port has no password; nothing to keep
  out of logs, /data or statuses besides addresses, which are not secret.
