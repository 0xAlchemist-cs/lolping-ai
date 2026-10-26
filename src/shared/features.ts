import type { RoomFeatureOff } from './roomProtocol';

export type FeatureId = 'emotes' | 'rooms' | 'roomText' | 'roomVotes' | 'roomPanel' | 'aiExplain' | 'quickActions';
export type Features = Record<FeatureId, boolean>;

/** In the order of the Features page. A feature with `requires` counts as off while that one is off. */
export const FEATURES: readonly { id: FeatureId; requires?: FeatureId }[] = [
  { id: 'emotes' },
  { id: 'rooms' },
  { id: 'roomText', requires: 'rooms' },
  { id: 'roomVotes', requires: 'rooms' },
  { id: 'roomPanel', requires: 'rooms' },
  { id: 'aiExplain' },
  { id: 'quickActions' },
];

/** Optional fork features start off until the user chooses to configure and enable them. */
export const DEFAULT_FEATURES: Features = {
  emotes: true, rooms: true, roomText: true, roomVotes: true, roomPanel: true, aiExplain: false, quickActions: false,
};

/** Missing or non-boolean keys use their own defaults; unknown keys are dropped. */
export function normalizeFeatures(raw: unknown): Features {
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_FEATURES };
  for (const { id } of FEATURES) {
    const v = r[id];
    if (typeof v === 'boolean') out[id] = v;
  }
  return out;
}

/** The room features this setup has switched off, as a room presence announces them. */
export function roomFeaturesOff(s: { features: Features }): RoomFeatureOff[] {
  return [...(featureOn(s, 'roomText') ? [] : ['text' as const]), ...(featureOn(s, 'roomVotes') ? [] : ['votes' as const])];
}

/** Whether a feature is in use: its own switch is on and so is the one it requires. */
export function featureOn(s: { features: Features }, id: FeatureId): boolean {
  const entry = FEATURES.find((f) => f.id === id);
  return s.features[id] && (entry?.requires === undefined || s.features[entry.requires]);
}

/** Which room keys the helper listens for: they exist only in an active room, so Alt+T and Tab reach other apps otherwise. */
export function liveKeys(
  s: { features: Features },
  room: { active: boolean },
  enabled: boolean,
): { text: boolean; panel: boolean } {
  const live = enabled && room.active;
  return { text: live && featureOn(s, 'roomText'), panel: live && featureOn(s, 'roomPanel') };
}
