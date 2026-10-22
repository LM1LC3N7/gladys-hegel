# Hegel for Gladys

Control your **Hegel** amplifiers with IP control (H95, H120, H190, H390,
H590, Röst…) from Gladys, locally, without any cloud: power on, standby,
volume (capped), mute and input.

> **Important.** This integration has never been tested with a real device:
> it was written from the `hegel-ip-client` library (the one Home Assistant
> uses) and tested against a fake amplifier only. Feedback is welcome.
> Unofficial integration, not affiliated with Hegel Music Systems.

## Installation

1. Connect the amplifier to your network and give it a **fixed IP address** in
   your router (reserved DHCP lease).
2. On the amplifier, enable **IP control** (setup menu, depending on the
   model) so that it also answers in standby and can be woken up.
3. In Gladys, install the **Hegel** integration, then open its configuration.
4. Type the IP addresses, separated by commas (for example
   `192.168.1.60, 192.168.1.61`). The control port is 50001; for another one,
   add it: `192.168.1.60:5000`.
5. Choose the **volume cap** (40 by default) and, if you wish, name the
   inputs.
6. The amplifiers appear in the **Discovery** tab: create them.

The integration keeps a connection open with each amplifier: what is changed
on the amplifier or its remote shows in Gladys at once. The states are also
read again every minute.

## What you get

| Feature  | Gladys type                | Note                                                  |
| -------- | -------------------------- | ----------------------------------------------------- |
| Power    | binary state (read only)   | 1 on, 0 in standby or unreachable                     |
| Power on | button                     | `-p.1`                                                |
| Standby  | button                     | `-p.0`                                                |
| Volume   | music / volume (0 to 100)  | the value of the amplifier display; command capped    |
| Mute     | button (television / mute) | each press reads the state, then sets the opposite    |
| Input    | dropdown                   | the inputs named or already seen; the list only grows |

On purpose, no **switch**: an "everything off" or "everything on" from a voice
assistant or a scene neither wakes nor cuts your amplifier.

## Volume cap

The volume of a Hegel amplifier goes from 0 to 100, as on its display; Gladys
shows the same value. A command from Gladys (dashboard, scene, voice
assistant) above the **cap** sets the cap, never more. The cap is read again
right before the line leaves for the amplifier: if a lower cap was saved
meanwhile, the command is refused and nothing is sent.

The volume set on the amplifier itself (knob, remote) is not changed by the
integration, except in the two cases where Gladys would make it heard:

- **Unmute**: if the volume of the amplifier is above the cap, it is first
  brought back to the cap, then the mute is removed. If the volume cannot be
  read, nothing is sent; if the amplifier does not confirm the lowering, or if
  the volume goes above the cap again right before sending, the mute is kept.
- **Power on**: as soon as the Power on line has left for the amplifier (even
  without an answer, with a late answer or an error), the volume is read again
  regularly for about 17 seconds and brought back to the cap when above it
  (start-up volume of the amplifier), including a volume reported above the
  cap during that time and a lowering the amplifier ignored. A Standby press
  does not stop these checks: they only lower, and only an amplifier that is
  on.

Mute: the value 0 sent by a scene unmutes (cap applied first); any other value
is a press, which sets the opposite of the state read from the amplifier.

A command succeeds only when the amplifier answers the value asked.

## Inputs

The protocol gives the number of the selected input, not its name. Type the
names in the configuration, numbered as in the manual of your model, for
example `1=Balanced, 2=Analog 1, 9=Network`. An input selected on the
amplifier is added to the list as "Input N".

## Commands

Every command is answered within 4 seconds (Gladys waits 5 seconds). A command
that left for the amplifier without confirmation (no answer, or an error line
`-e.N` from the amplifier) is reported "sent, without confirmation"; the line
the amplifier writes next shows what it did. A command that could not leave is
reported "nothing sent". **Standby** goes before every command waiting,
cancels a Power on still waiting, and leaves as soon as the connection is open,
even before the states are first read.

## Reconnection

An amplifier that does not answer (off, IP control disabled, unplugged) shows
its power at 0 and is named in the integration status. The integration
reconnects after 10 s, then at intervals doubled after each failure, up to 5
minutes. Two reads in a row without an answer close the connection, then the
same spaced reconnection applies. Saving the configuration without changing
the address does not shorten that wait; the search button of the Discovery tab
asks for an attempt, at the earliest 10 s after the previous one. The time of the last attempt is kept in
`/data`: after a restart of the integration, an amplifier is not asked again
less than a minute after that attempt.

## Configuration button

- **Check the amplifiers**: the connection, power, volume, mute and input of
  each amplifier, as known (no extra request to the amplifier), and the cap in
  force.

## Data and privacy

The integration asks for no account and no password: Hegel IP control has
none. It keeps in `/data/hegel.json` the list of known amplifiers (address,
inputs) and the time of the last connection attempt. Nothing leaves your local
network.

## Known limits

- The identity of an amplifier is its address: the protocol gives neither a
  serial number nor a model. Keep a fixed IP address: if two amplifiers swap
  their addresses (DHCP lease), the Gladys device of one commands and shows
  the other, without warning, and its inputs are added to the list of the
  first. Do not type the same amplifier twice (IP address and name): you would
  get two devices and two connections, which the amplifier may not accept.
- A Hegel amplifier may accept only one IP control client at a time: close
  the other tools connecting to it.
- No volume steps (`-v.u` / `-v.d`), no display brightness nor standby delay.
- Never tested with a real device: the real answers may differ.
