# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Hegel amplifiers with IP control (port 50001 by default), added by IP
  address, without any cloud.
- Power state (read only), "Power on" and "Standby" buttons, volume (0 to 100
  as on the amplifier display, validated strictly, capped by the new
  `max_volume` option, 40 by default), mute (each press reads the mute and
  sets the opposite) and an "Input" dropdown read and set, with names typed in
  the new `input_names` option.
- Changes made on the amplifier or its remote are pushed to Gladys (grouped,
  at most once a second per device); the states are also read again every
  minute.
- Unmuting lowers a volume above the cap to the cap first (mute kept when the
  amplifier does not confirm it); Power on brings the volume back to the cap
  after the wake-up.
- Standby goes before every command waiting, cancels a Power on still
  waiting, and can be sent as soon as the connection is open. Every command is
  answered to Gladys within 4 seconds, or dropped, never sent late; a command
  is confirmed only by the value asked.
- An amplifier that does not answer shows its power at 0 and is named in the
  integration status; it is connected again after 10 s, then at intervals
  doubled up to 5 minutes. A restarted integration never asks an amplifier
  sooner than a minute after the last attempt.
- "Check the amplifiers" button.
- A mute value of 0 sent by a scene unmutes (cap applied first); any other
  value is a press.

### Fixed

- The volume checks after Power on run as soon as the line has left, even
  when the amplifier answers late, with an error or not at all, and go on for
  the whole wake-up window: a Standby or a refused second Power on no longer
  stops them, and a lowering the amplifier ignored is tried again.
- The cap is checked again right before each volume line leaves: a cap
  lowered while the line waited drops it, nothing sent; unmuting is refused
  when the volume went above the cap meanwhile.
- Deadlines run on a monotonic clock, and a Standby always wins over a Power
  on pressed before it, whatever the system clock does.
- Saving an unchanged configuration no longer shortens the wait before the
  next connection attempt.
- Every state publication counts in one global budget, under the rate Gladys
  accepts; statuses are published one at a time, in order.
- A failed configuration read when connecting to Gladys is tried again,
  spaced out.

### Security

- Lines are bounded (64 characters) and parsed once by an anchored
  expression; only the expected letters are read; only well-formed values are
  written; a connection flooded with lines is closed. The tables of `/data`
  have no prototype.

[Unreleased]: https://github.com/LM1LC3N7/gladys-hegel/commits/main
