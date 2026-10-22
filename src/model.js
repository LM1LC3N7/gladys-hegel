// -----------------------------------------------------------------------------
// Known devices -> Gladys devices and states (pure). One Gladys device per
// address (the Hegel IP control protocol gives no serial number).
//
// The categories and types are the ones of the Gladys core: `music/volume`
// like the core Sonos service, `television/volume-mute` for the mute press
// (music has no mute type), `text/select` for the input, `button/push` for
// "Power on" and "Standby", and the power state read only (`unknown/binary`):
// no switch, nothing an "everything on / off" (voice assistants, scenes) could
// turn into a command. No unit: the core lists none for these categories.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { addressKey } from './config.js';
import { DEVICE_TYPE, FEATURES } from './constants.js';

/** The feature definitions, by frozen key, in their frozen order. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    keep_history: true,
  },
  [FEATURES.POWER_ON]: {
    name: 'Power on',
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
  },
  [FEATURES.STANDBY]: { name: 'Standby', category: C.BUTTON, type: T.BUTTON.PUSH, min: 0, max: 1 },
  [FEATURES.VOLUME]: {
    name: 'Volume',
    category: C.MUSIC,
    type: T.MUSIC.VOLUME,
    min: 0,
    max: 100,
    has_feedback: true,
  },
  [FEATURES.MUTE]: {
    name: 'Mute',
    category: C.TELEVISION,
    type: T.TELEVISION.VOLUME_MUTE,
    min: 0,
    max: 1,
    has_feedback: true,
  },
  [FEATURES.INPUT]: {
    name: 'Input',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
});

/** The options of the "Input" dropdown: every input this device has shown or was named. */
export const inputOptions = (device) =>
  (Array.isArray(device.inputOptions) ? device.inputOptions : []).map(({ value, label }) => ({
    value,
    label,
  }));

export function deviceName(device) {
  return `Hegel ${addressKey(device)}`;
}

export function buildDevice(gladys, device) {
  const ids = gladys.externalIds(DEVICE_TYPE, device.id);
  return {
    name: deviceName(device),
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'IP_ADDRESS', value: device.host }],
    // Always the full, fixed list: a device published again never loses a feature.
    features: Object.entries(FEATURE_SPECS).map(([key, { name, ...spec }]) => ({
      name,
      external_id: ids.feature(key),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      ...spec,
      ...(key === FEATURES.INPUT ? { supported_options: inputOptions(device) } : {}),
    })),
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/**
 * The states of a device. `state` is the link state of a connected device,
 * `null` for a device that does not answer (power 0 only), undefined for
 * "nothing known" (nothing published). Every state is a finite number or a
 * known option: never undefined, never NaN.
 */
export function stateList(gladys, device, state) {
  if (state === undefined) {
    return [];
  }
  const ids = gladys.externalIds(DEVICE_TYPE, device.id);
  const id = (key) => ids.feature(key);
  if (state === null) {
    return [{ device_feature_external_id: id(FEATURES.POWER), state: 0 }];
  }
  const states = [];
  if (typeof state.power === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.POWER), state: state.power ? 1 : 0 });
  }
  if (Number.isInteger(state.volume) && state.volume >= 0 && state.volume <= 100) {
    states.push({ device_feature_external_id: id(FEATURES.VOLUME), state: state.volume });
  }
  if (typeof state.mute === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.MUTE), state: state.mute ? 1 : 0 });
  }
  if (
    typeof state.input === 'string' &&
    inputOptions(device).some((option) => option.value === state.input)
  ) {
    states.push({ device_feature_external_id: id(FEATURES.INPUT), text: state.input });
  }
  return states;
}
