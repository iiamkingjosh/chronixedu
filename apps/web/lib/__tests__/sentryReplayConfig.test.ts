/**
 * The ratchet on session replay (SECURITY.md Round 43). It loads instrumentation-client.ts itself, the
 * file the browser runs, with @sentry/nextjs replaced by a recorder, and reads what Sentry was given.
 * It fails if the masking flags come off, if replay starts recording sessions without an error, or if
 * compression is switched back on (the transport could no longer scrub the recording). Nothing caught
 * any of that before: the flags were stated in one place and tested nowhere. Since Round 44 it also fails if
 * what the transport keeps back stops being told, or if that notice could start a replay.
 */
const mockInit = jest.fn();
const mockReplayIntegration = jest.fn((options: Record<string, unknown>) => ({ name: 'Replay', options }));
const mockMakeFetchTransport = jest.fn((_options: unknown) => ({ send: jest.fn(), flush: jest.fn() }));
const mockCaptureMessage = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  init: (options: unknown) => mockInit(options),
  replayIntegration: (options: Record<string, unknown>) => mockReplayIntegration(options),
  makeFetchTransport: (options: unknown) => mockMakeFetchTransport(options),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
  captureRouterTransitionStart: jest.fn(),
}));

type InitOptions = {
  replaysSessionSampleRate?: number;
  replaysOnErrorSampleRate?: number;
  transport?: (options: object) => { send: unknown; flush: unknown };
  integrations?: unknown[];
};

/** Loads instrumentation-client.ts fresh, as a browser on `pathname` would, and returns what init got. */
function loadOn(pathname: string): InitOptions {
  mockInit.mockClear();
  mockReplayIntegration.mockClear();
  mockCaptureMessage.mockClear();
  (globalThis as { window?: unknown }).window = { location: { pathname } };
  try {
    jest.isolateModules(() => { require('../../instrumentation-client'); });
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
  expect(mockInit).toHaveBeenCalledTimes(1);
  return mockInit.mock.calls[0][0] as InitOptions;
}

describe('session replay, as instrumentation-client.ts configures it', () => {
  it('records only when an error happens: the baseline sample is 0, the on-error sample 1', () => {
    const options = loadOn('/registrar/students');
    expect(options.replaysSessionSampleRate).toBe(0);
    expect(options.replaysOnErrorSampleRate).toBe(1);
  });

  it('masks all text and inputs, blocks all media, and keeps compression off so the transport can scrub', () => {
    loadOn('/registrar/students');
    // The control: on an ordinary page replay is set up at all, so the flags below are really read.
    expect(mockReplayIntegration).toHaveBeenCalledTimes(1);
    expect(mockReplayIntegration.mock.calls[0][0]).toMatchObject({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
      useCompression: false,
    });
  });

  it('keeps a notice of a drop from starting a replay, and lets an ordinary error start one', () => {
    loadOn('/registrar/students');
    const { beforeErrorSampling } = mockReplayIntegration.mock.calls[0][0] as { beforeErrorSampling?: (e: object) => boolean };
    expect(typeof beforeErrorSampling).toBe('function');
    expect(beforeErrorSampling!({ message: 'sentry_item_not_sent' })).toBe(false);
    // The control: a guard that refused everything would also pass the line above.
    expect(beforeErrorSampling!({ exception: { values: [{ type: 'Error', value: 'x' }] } })).toBe(true);
  });

  /** The transport instrumentation-client.ts builds, around a recorder standing in for the SDK's own. */
  function configuredTransport() {
    const options = loadOn('/registrar/students');
    expect(typeof options.transport).toBe('function');
    const transport = options.transport!({}) as { send: (e: unknown) => Promise<unknown> };
    expect(mockMakeFetchTransport).toHaveBeenCalled();
    const base = mockMakeFetchTransport.mock.results[mockMakeFetchTransport.mock.results.length - 1].value as { send: jest.Mock };
    return { transport, base };
  }

  it('drops a recording it cannot read before the SDK sends it, and says so once', async () => {
    const { transport, base } = configuredTransport();
    await transport.send([{}, [[{ type: 'replay_recording' }, new Uint8Array([1])]]]);
    await transport.send([{}, [[{ type: 'replay_recording' }, new Uint8Array([2])]]]);
    expect(base.send).not.toHaveBeenCalled();
    expect(mockCaptureMessage.mock.calls).toEqual([
      ['sentry_item_not_sent', { level: 'warning', tags: { reason: 'replay_unreadable', item_type: 'replay_recording' } }],
    ]);
  });

  it('sends only the item types it names, and says what it removed', async () => {
    const { transport, base } = configuredTransport();
    await transport.send([{}, [[{ type: 'statsd' }, 'probe:1|c'], [{ type: 'event' }, { message: 'ok' }]]]);
    // The control: the event in the same envelope still goes.
    expect(base.send).toHaveBeenCalledTimes(1);
    expect((base.send.mock.calls[0][0] as [unknown, Array<[{ type: string }]>])[1].map(([h]) => h.type)).toEqual(['event']);
    expect(mockCaptureMessage.mock.calls).toEqual([
      ['sentry_item_not_sent', { level: 'warning', tags: { reason: 'item_type_not_allowed', item_type: 'statsd' } }],
    ]);
  });

  it('sets up no replay at all on the sign-in pages or the platform-admin area', () => {
    for (const pathname of ['/login', '/reset-password', '/super-admin/security']) {
      const options = loadOn(pathname);
      expect({ pathname, replay: mockReplayIntegration.mock.calls.length, integrations: options.integrations })
        .toEqual({ pathname, replay: 0, integrations: [] });
    }
  });
});
