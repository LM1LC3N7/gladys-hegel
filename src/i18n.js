// -----------------------------------------------------------------------------
// The texts users read in Gladys (configuration button, connection status),
// in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });
const list = (items) => items.join(', ');
const onOff = (value, [en1, en0, enU], [fr1, fr0, frU]) =>
  value === true ? [en1, fr1] : value === false ? [en0, fr0] : [enU, frU];

export const T = {
  noDevice: both(
    'No amplifier known yet: type their IP addresses in the configuration.',
    'Aucun ampli connu : saisissez leurs adresses IP dans la configuration.',
  ),
  check: (lines, config) => ({
    en: [...lines.map((l) => l.en), `Volume cap: ${config.maxVolume}`].join(' · '),
    fr: [...lines.map((l) => l.fr), `Plafond de volume : ${config.maxVolume}`].join(' · '),
  }),
  checkLine: (label, state, error) => {
    if (!state) {
      const reason = error ? ` (${error})` : '';
      return both(`${label}: not connected${reason}`, `${label} : non connecté${reason}`);
    }
    const [enPower, frPower] = onOff(
      state.power,
      ['on', 'standby', 'power unknown'],
      ['allumé', 'en veille', 'marche inconnue'],
    );
    const [enMute, frMute] = onOff(
      state.mute,
      ['muted', 'not muted', 'mute unknown'],
      ['sourdine', 'sans sourdine', 'sourdine inconnue'],
    );
    const volume = Number.isInteger(state.volume) ? String(state.volume) : undefined;
    const en = [
      enPower,
      volume ? `volume ${volume}` : 'volume unknown',
      enMute,
      state.input ? `input ${state.input}` : undefined,
    ];
    const fr = [
      frPower,
      volume ? `volume ${volume}` : 'volume inconnu',
      frMute,
      state.input ? `entrée ${state.input}` : undefined,
    ];
    return both(
      `${label}: connected, ${en.filter(Boolean).join(', ')}`,
      `${label} : connecté, ${fr.filter(Boolean).join(', ')}`,
    );
  },
  unreachable: (names) =>
    both(
      `Not connected (off, network control disabled, or unreachable), tried again at spaced intervals: ${list(names)}.`,
      `Non connectés (éteints, contrôle IP désactivé, ou injoignables), réessayés à intervalles espacés : ${list(names)}.`,
    ),
  noAnswerAt: (addresses) =>
    both(
      `No Hegel amplifier answers yet at: ${list(addresses)}.`,
      `Aucun ampli Hegel ne répond encore à : ${list(addresses)}.`,
    ),
  invalidEntries: (entries) =>
    both(
      `Ignored in the configuration (invalid): ${list(entries)}.`,
      `Ignorés dans la configuration (invalides) : ${list(entries)}.`,
    ),
  dataReset: both(
    'The saved device list was unreadable and was reset; the amplifiers are found again from their addresses.',
    'La liste enregistrée des appareils était illisible et a été réinitialisée ; les amplis sont retrouvés par leurs adresses.',
  ),
};
