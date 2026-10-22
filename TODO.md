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
- [x] **Review 1 fixes** (2026-10-22): cap net after every Power on that
      left (I1), kept through Standby and a refused second Power on, retried
      to the end of the window (I2), cap and volume asked again right before
      each line leaves (I3), monotonic clock and press order (M1), mute value
      (M2), docs on address swaps (M3), no faster retry on an unchanged save
      (M4), global state budget (M5), serialized statuses and start epochs
      (M6), configuration read retried on connection (M7), details (M8).
      Tests: `test/review1.test.js`.
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
    `television/volume-mute` press (and the value the dashboard really sends
    for it: 1 every time, or 0/1), the two `button/push`, the
    `unknown/binary` power and the `text/select` input;
  - (review 1, M3) a readable identifier to check the identity again on
    every connection: the UPnP description (`UDN`, `serialNumber`) of the
    network models, or a model answer of the protocol if one exists; an
    unreadable value must never count as "another amplifier".
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
  as a Hegel amplifier does on every new connection. (Review 1, M3) Accepted
  for v1, as gladys-nad: two amplifiers swapping addresses swap devices
  without warning (the cap stays global, so no danger beyond the wrong
  amplifier), and the same amplifier typed twice gets two links; both said in
  the docs, a readable identifier is in milestone 2.
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
  first on the connection (after the one exchange already written; never
  refused by the limit of exchanges waiting, review 1 M8), cancels a Power on
  still queued; a Power on whose line still waits on the connection is
  dropped right before the write (`shouldSend`, "Cancelled by Standby,
  nothing sent"). (Review 1, M1) The order is a sequence number of the
  presses, never a clock. (Review 1, I2) It leaves the wake-up window and the
  volume checks running: they only lower, and only an amplifier on, and an
  amplifier busy waking up may ignore the Standby. It only needs an open
  connection, not the first read (lesson of lot 11: stop possible before the
  first read): during the snapshot of a new connection it goes before the
  next query. No rate pause exists here (local, no 429), so nothing can block
  it.
- **Volume cap** (brief: "volume plafonné par option"): Hegel counts 0..100,
  as its display; Gladys shows the same value (`music/volume` 0..100, frozen
  at creation). `max_volume` (1..100, 40 by default) caps every command:
  `Math.min(value, cap)` with the cap read inside the queued task; a command
  above it sets the cap and succeeds (logged). (Review 1, I3) The cap is
  asked again in the pump of the link, right before every `-v.<n>` leaves
  (commands, lowerings): a cap lowered while the line waited drops it,
  "above the cap, nothing sent".
  Chosen over a percent mapping (as gladys-nad does in dB) because the Hegel
  scale is already 0..100: what Gladys shows is what the amplifier shows. A
  volume set on the amplifier itself above the cap is not lowered, except by
  the two commands of Gladys that would make it heard (as gladys-nad): unmute
  (the volume read again first; above the cap, `-v.<cap>` then `-m.0`;
  unknown: refused, nothing sent; lowering not confirmed: mute kept; review 1
  I3: `-m.0` leaves only if the volume known right before the write is at or
  under the cap, else "volume above the cap, mute kept, nothing sent") and
  Power on. (Review 1, I1 and I2, as gladys-cambridge-audio 0.1.2) As the
  `-p.1` line leaves (`onSent`), whatever its answer (confirmed, late,
  `-e.N`, connection closed), the wake-up window opens ((6 + 1) × 2.5 s) and
  the check chain starts over: every 2.5 s, 6 times, through the device
  queue, power and volume read, lowered when on and above the cap; it never
  stops at a first volume under the cap (a start-up volume applied later
  without a push is still seen). A press that never left touches neither the
  window nor the chain (a refused second press keeps the first one's checks).
  A volume pushed above the cap inside the window is lowered too, and a
  lowering not confirmed is tried again by the chain (restarted if it ended
  while the window is open). The ack of Power on never depends on it.
- Volume validated strictly before queueing: an integer 0..100 as a number or
  a string of digits; null, '', booleans, 12.5, '12abc', NaN refused.
- Mute is a push: `-m.?` read again just before (1.5 s at most) and the
  explicit `-m.0` / `-m.1` sent, never the toggle `-m.t`. Unknown mute state:
  nothing sent. (Review 1, M2, as gladys-linn) The value 0 (number or "0")
  asks to unmute (cap applied first; nothing sent when not muted); any other
  value is a press (the dashboard is believed to send 1 every time: to check
  at milestone 2).
- Input: the protocol gives a number (1..20 accepted), no name. The options:
  names typed in `input_names` (`1=Balanced, 9=Network`, override), then any
  input value seen ("Input N"). No default per model in v1: the numbering
  differs per model and was not verified.
- Commands: serialized per device (mute goes before the commands waiting),
  budget 3.5 s from the Gladys request, the waits included; each exchange
  bounded by what is left; a command still queued at its deadline is dropped,
  never sent late. (Review 1, M1) Budgets, deadlines and the wake-up window
  run on a monotonic clock (`performance.now()`), the wall clock only for the
  attempt times of /data; the deadline flag (`late`) is asked again right
  before every line of a command leaves. The ack never waits for a
  publication to Gladys. A line
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
  minutes; the count is only reset by a connection that stayed up 60 s.
  (Review 1, M4) A configuration save, changed or not, never shortens the
  wait of an existing link (a new address gets its own link); the Discovery
  scan is the one explicit retry, never sooner than 10 s after the last
  attempt. (Review 1, M7) A failed `getConfig` on a connection to Gladys is
  tried again after 30 s, doubled up to 5 minutes, until it works or a
  configuration save starts the app. One attempt at a time per link (a
  retry asked during an attempt starts nothing). A poll every 60 s (`-p.?`,
  then volume, mute, input), one query at a time; two polls in a row without
  an answer close the connection. TCP keep-alive at 30 s.
- Restarts (lesson of lots 11 and 12): the time of each connection attempt is
  written to `/data/hegel.json` **before** the attempt, at most once a minute
  per address; a restarted container does not ask an address before a minute
  after the saved time (`firstWait`, also applied to a retry asked
  meanwhile). A crash loop therefore asks an amplifier at most once a minute.
  Saves are serialized (one write at a time). Entries of addresses no longer
  wanted are dropped.
- Late events: a link replaced or stopped (configuration changed) publishes
  nothing (`links.get(key) === link` and `started` checked); the grouped
  publications check the app generation; a status published by a stopped
  generation is not remembered as published. (Review 1, M6) The statuses are
  published one at a time, each computed when its turn comes; every start()
  has an epoch, checked after each await (a late `getDevices` of an older
  start changes nothing).
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
  NaN. (Review 1, M5) One global budget of 250 states in any minute counts
  every publication (grouped, immediate, after a creation or a reconnection);
  beyond it the publication is deferred, never lost (the states are read
  again when it runs). No `publishSceneEvent`, no energy index.
- Categories and types from the core only (`server/utils/constants.js`):
  `music/volume` (as the core Sonos service), `television/volume-mute` (music
  has no mute type), `text/select`, `button/push`, `unknown/binary`. No unit:
  `DEVICE_FEATURE_UNITS_BY_CATEGORY` lists none for music, television, text,
  button or unknown. Store category `multimedia`.
- No secret anywhere: the Hegel control port has no password; nothing to keep
  out of logs, /data or statuses besides addresses, which are not secret.
