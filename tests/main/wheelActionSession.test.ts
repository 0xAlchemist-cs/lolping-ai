import { describe, expect, it } from 'vitest';
import { WheelActionSession } from '../../src/main/wheelActionSession';
import { DEFAULT_WHEEL } from '../../src/shared/pings';

function setup() {
  let now = 0;
  const sessions = new WheelActionSession(() => now);
  const open = (wheel = [...DEFAULT_WHEEL], size = 600) => sessions.begin({
    displayId: 2, x: 100, y: 200, wheel, wheelSizePx: size,
  });
  return { sessions, open, advance: (ms: number) => { now += ms; } };
}

describe('WheelActionSession', () => {
  it('accepts the expected icon once after a real release', () => {
    const { sessions, open } = setup();
    open();
    const id = sessions.release(2, 300, 200);
    expect(typeof id).toBe('number');
    expect(sessions.consume(2, { sessionId: id, id: 'omw' })).toBe('omw');
    expect(sessions.consume(2, { sessionId: id, id: 'omw' })).toBeNull();
  });

  it('does not accept a report before release or from a different display', () => {
    const { sessions, open } = setup();
    open();
    expect(sessions.consume(2, { sessionId: 1, id: 'omw' })).toBeNull();
    const id = sessions.release(2, 300, 200);
    expect(sessions.consume(1, { sessionId: id, id: 'omw' })).toBeNull();
    expect(sessions.consume(2, { sessionId: id, id: 'danger' })).toBeNull();
    expect(sessions.consume(2, { sessionId: id, id: 'omw' })).toBe('omw');
  });

  it('reserves the standard question mark and cancels the centre', () => {
    const { sessions, open } = setup();
    open();
    expect(sessions.release(2, -100, 200)).toBeNull();
    open();
    expect(sessions.release(2, 101, 201)).toBeNull();
  });

  it('uses the snapshot icon arrangement and scaled dead zone', () => {
    const { sessions, open } = setup();
    const wheel = [...DEFAULT_WHEEL];
    [wheel[0], wheel[2]] = [wheel[2], wheel[0]];
    open(wheel, 300);
    wheel[2] = 'missing';
    const id = sessions.release(2, 144, 200);
    expect(sessions.consume(2, { sessionId: id, id: 'danger' })).toBe('danger');
    open([...DEFAULT_WHEEL], 900);
    expect(sessions.release(2, 200, 200)).toBeNull();
  });

  it('expires reports without an idle timer', () => {
    const { sessions, open, advance } = setup();
    open();
    const id = sessions.release(2, 300, 200);
    advance(2000);
    expect(sessions.consume(2, { sessionId: id, id: 'omw' })).toBeNull();
  });

  it('invalidates old reports on cancellation or a new gesture', () => {
    const { sessions, open } = setup();
    open();
    const first = sessions.release(2, 300, 200);
    sessions.cancel();
    expect(sessions.consume(2, { sessionId: first, id: 'omw' })).toBeNull();
    open();
    const second = sessions.release(2, 300, 200);
    open();
    expect(sessions.consume(2, { sessionId: second, id: 'omw' })).toBeNull();
    expect(sessions.release(99, 300, 200)).toBeNull();
  });
});
