// -----------------------------------------------------------------------------
// A fake Hegel amplifier on 127.0.0.1 (a random port): the IP control
// protocol. `-x.?` is answered `-x.<value>`, `-x.<value>` sets it and is
// echoed; an unknown letter or a bad value is answered `-e.<n>`. Option
// `quietWhenOff`: in standby, only `-p` is answered.
// -----------------------------------------------------------------------------

import { createServer } from 'node:net';

export async function startFakeHegel(options = {}) {
  const state = { p: '1', v: '30', m: '0', i: '1', ...options.state };
  const fake = {
    state,
    received: [],
    sockets: new Set(),
    connections: 0,
    /** Letters never answered. */
    unanswered: new Set(options.unanswered ?? []),
    /** Letters whose command is answered by an error line. */
    errors: new Set(options.errors ?? []),
    /** Letters whose query is answered by an error line. */
    queryErrors: new Set(options.queryErrors ?? []),
    /** letter -> ms before the answer. */
    delays: { ...options.delays },
    silent: Boolean(options.silent),
    /** What the volume becomes on `-p.1` (an amplifier waking up at its start-up volume). */
    wakeVolume: options.wakeVolume,
    /** Letters whose command is not applied: the current value is answered. */
    ignoreSet: new Set(options.ignoreSet ?? []),
    commands() {
      return this.received.filter((line) => !line.endsWith('?'));
    },
    push(line) {
      for (const socket of this.sockets) {
        socket.write(`${line}\r`);
      }
    },
    write(data) {
      for (const socket of this.sockets) {
        socket.write(data);
      }
    },
    dropAll() {
      for (const socket of this.sockets) {
        socket.destroy();
      }
    },
  };

  const reply = (socket, letter, text) => {
    const send = () => {
      if (!socket.destroyed) {
        socket.write(`${text}\r`);
      }
    };
    const delay = fake.delays[letter];
    if (delay) {
      setTimeout(send, delay);
    } else {
      send();
    }
  };

  const handle = (socket, line) => {
    fake.received.push(line);
    if (fake.silent) {
      return;
    }
    const match = /^-([a-z])\.(.+)$/.exec(line);
    if (!match || !Object.hasOwn(state, match[1])) {
      socket.write('-e.2\r');
      return;
    }
    const [, letter, value] = match;
    if (fake.unanswered.has(letter)) {
      return;
    }
    if (options.quietWhenOff && state.p === '0' && letter !== 'p') {
      return;
    }
    if (value === '?' && fake.queryErrors.has(letter)) {
      reply(socket, letter, '-e.1');
      return;
    }
    if (value !== '?') {
      if (fake.errors.has(letter)) {
        reply(socket, letter, '-e.3');
        return;
      }
      if (!fake.ignoreSet.has(letter)) {
        state[letter] = value;
      }
      if (letter === 'p' && value === '1' && fake.wakeVolume !== undefined) {
        state.v = fake.wakeVolume;
      }
    }
    reply(socket, letter, `-${letter}.${state[letter]}`);
  };

  const server = createServer((socket) => {
    fake.connections += 1;
    fake.sockets.add(socket);
    socket.on('close', () => fake.sockets.delete(socket));
    socket.on('error', () => {});
    let text = '';
    socket.on('data', (chunk) => {
      for (const byte of chunk) {
        if (byte === 13 || byte === 10) {
          if (text.trim() !== '') {
            handle(socket, text.trim());
          }
          text = '';
        } else {
          text += String.fromCharCode(byte);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  fake.close = () =>
    new Promise((resolve) => {
      fake.dropAll();
      server.close(() => resolve());
    });
  return fake;
}

/** A port on 127.0.0.1 where nothing listens (opened, then closed). */
export async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
