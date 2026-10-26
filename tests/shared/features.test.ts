import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATURES, featureOn, liveKeys, normalizeFeatures, roomFeaturesOff } from '../../src/shared/features';

describe('features', () => {
  it('turns the room and emote features on by default, and optional fork features off', () => {
    expect(normalizeFeatures(undefined)).toEqual(DEFAULT_FEATURES);
    const { aiExplain, quickActions, ...rest } = DEFAULT_FEATURES;
    expect(Object.values(rest).every((v) => v)).toBe(true);
    expect(aiExplain).toBe(false);
    expect(quickActions).toBe(false);
  });

  it('keeps aiExplain off in an old settings file, and honours an explicit choice', () => {
    expect(normalizeFeatures({})).toEqual(DEFAULT_FEATURES);
    expect(normalizeFeatures({ aiExplain: true })).toEqual({ ...DEFAULT_FEATURES, aiExplain: true });
  });

  it('keeps quick actions off for old or malformed settings and honours an explicit choice', () => {
    for (const quickActions of [undefined, null, 'true', 1, {}]) {
      expect(normalizeFeatures({ quickActions }).quickActions).toBe(false);
    }
    const enabled = normalizeFeatures({ quickActions: true, rooms: false });
    expect(featureOn({ features: enabled }, 'quickActions')).toBe(true);
    expect(featureOn({ features: normalizeFeatures({ quickActions: false }) }, 'quickActions')).toBe(false);
    expect(roomFeaturesOff({ features: enabled })).toEqual(['text', 'votes']);
  });

  it('repairs a broken value key by key', () => {
    const f = normalizeFeatures({ rooms: false, emotes: 1, extra: true });
    expect(f).toEqual({ ...DEFAULT_FEATURES, rooms: false });
    expect('extra' in f).toBe(false);
    expect(normalizeFeatures('yes')).toEqual(DEFAULT_FEATURES);
    expect(normalizeFeatures([true])).toEqual(DEFAULT_FEATURES);
  });

  it('counts a room feature as off while rooms are off', () => {
    const s = { features: { ...DEFAULT_FEATURES, rooms: false } };
    expect(featureOn(s, 'roomText')).toBe(false);
    expect(featureOn(s, 'roomVotes')).toBe(false);
    expect(featureOn(s, 'roomPanel')).toBe(false);
    expect(featureOn(s, 'rooms')).toBe(false);
    expect(featureOn(s, 'emotes')).toBe(true);
  });

  it('keeps a room feature off by its own switch while rooms are on', () => {
    const s = { features: { ...DEFAULT_FEATURES, roomVotes: false } };
    expect(featureOn(s, 'roomVotes')).toBe(false);
    expect(featureOn(s, 'roomText')).toBe(true);
  });

  it('lists the room features that are off, and all of them when rooms are off', () => {
    expect(roomFeaturesOff({ features: DEFAULT_FEATURES })).toEqual([]);
    expect(roomFeaturesOff({ features: { ...DEFAULT_FEATURES, roomVotes: false } })).toEqual(['votes']);
    expect(roomFeaturesOff({ features: { ...DEFAULT_FEATURES, roomText: false, roomVotes: false } })).toEqual(['text', 'votes']);
    expect(roomFeaturesOff({ features: { ...DEFAULT_FEATURES, rooms: false } })).toEqual(['text', 'votes']);
  });

  it('turns the text key on only in an active room with text on', () => {
    const on = { features: DEFAULT_FEATURES };
    expect(liveKeys(on, { active: true }, true)).toEqual({ text: true, panel: true });
    expect(liveKeys(on, { active: false }, true)).toEqual({ text: false, panel: false });
    expect(liveKeys(on, { active: true }, false)).toEqual({ text: false, panel: false });
    expect(liveKeys({ features: { ...DEFAULT_FEATURES, roomText: false } }, { active: true }, true))
      .toEqual({ text: false, panel: true });
    expect(liveKeys({ features: { ...DEFAULT_FEATURES, roomPanel: false } }, { active: true }, true))
      .toEqual({ text: true, panel: false });
    expect(liveKeys({ features: { ...DEFAULT_FEATURES, rooms: false } }, { active: true }, true))
      .toEqual({ text: false, panel: false });
  });
});
