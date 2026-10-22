# gladys-hegel

[Gladys Assistant](https://gladysassistant.com) external integration for
**Hegel** amplifiers with IP control (H95, H120, H190, H390, H590, Röst…), on
the local network: power on, standby, volume (capped by an option), mute and
input, through the Hegel IP control protocol over TCP (port 50001), without
any cloud. Unofficial, not affiliated with Hegel Music Systems.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake amplifier only,
> never with a real Hegel amplifier.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (HegelApp)
                                   ├─ src/hegel/link.js      one address: TCP connection, snapshot, pushed lines, poll, spaced reconnection
                                   ├─ src/hegel/protocol.js  commands, lines, values (ported, untrusted input)
                                   ├─ src/model.js           known devices -> Gladys devices and states (pure)
                                   ├─ src/config.js          addresses, volume cap, input names
                                   └─ src/store.js           /data/hegel.json: known devices, their inputs, last attempts
```

- **Devices** are added by IP address (configuration): the protocol gives no
  serial number, so the address is the identity (external id
  `hegel:<host>`, or `hegel:<host>_<port>` for a port other than 50001). A
  created device unknown to `/data` is found again from its external id.
- **One TCP connection per address**, kept open: on connection `-p.?` must be
  answered (else "not a Hegel amplifier"), then the volume, mute and input are
  read. Every line the amplifier writes is merged and published (grouped, at
  most once a second per device). A poll every minute; two polls in a row
  without an answer to `-p.?` close the connection. Reconnection after 10 s,
  then doubled after each failure up to 5 minutes; the time of the last
  attempt is written to `/data` before it (at most once a minute), and a
  restarted container waits a minute after it.
- **One exchange at a time** per connection (the answer is matched by its
  letter; an error line `-e.N` ends the exchange in flight as "sent, without
  confirmation"), each with a deadline counted from its request.
- **Commands**: validated first (volume an integer 0..100, input among the
  dropdown options), serialized per device, each within a 3.5 s budget
  (Gladys acks in 5 s). The volume is capped by `max_volume`, read just before
  sending. Mute is a press: the state is read just before and the explicit
  value sent; unmuting (and Power on) first brings a volume above the cap back
  to it. Standby skips the device queue, goes first on the connection (even
  before the first read), and cancels a Power on still waiting.
- **Features**: `music/volume`, `television/volume-mute`, `text/select`
  (input), `button/push` (power on, standby) and a read-only `unknown/binary`
  power state. No switch, no unit.
- **Bounded input**: lines of 64 characters at most (longer ones dropped), one
  anchored expression per line, values parsed strictly, only well-formed values
  of the known letters written, 16 exchanges waiting at most, a connection
  flooded with more than 300 lines in 10 s is closed.

## Development

```bash
npm install
npm test                                        # node --test, loopback only (fake amplifier)
npm run lint && npm run format:check
npm run audit
npm run cover                                   # regenerates cover.png (800×534, no dependency)
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/fakeHegel.js` is a fake Hegel amplifier on 127.0.0.1 (queries,
settings, pushed lines, error lines, silent, slow and standby modes). The
end-to-end tests run the real handlers against the SDK's fake Gladys.

## Credits

- [`hegel-ip-client`](https://github.com/boazca/hegel-ip-client) 0.1.4
  (MIT), the library behind the Home Assistant Hegel integration: the protocol
  and the commands are ported to JavaScript.
- The app structure follows
  [LM1LC3N7/gladys-nad](https://github.com/LM1LC3N7/gladys-nad) (same author,
  Apache-2.0).

Hegel is a trademark of its owner, used here only to name the compatible
products.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release.

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices (hegel-ip-client,
MIT): [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
