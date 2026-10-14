/**
 * The ratchet on session replay (SECURITY.md Round 43). It loads instrumentation-client.ts itself, the
 * file the browser runs, with @sentry/nextjs replaced by a recorder, and reads what Sentry was given.
 * It fails if the masking flags come off, if replay starts recording sessions without an error, or if
 * compression is switched back on (the transport could no longer scrub the recording). Nothing caught
 * any of that before: the flags were stated in one place and tested nowhere.
 */
const mockInit = jest.fn();
const mockReplayIntegration = jest.fn((options: Record<string, unknown>) => ({ name: 'Replay', options }));
const mockMakeFetchTransport = jest.fn((_options: unknown) => ({ send: jest.fn(), flush: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({
  init: (options: unknown) => mockInit(options),
  replayIntegration: (options: Record<string, unknown>) => mockReplayIntegration(options),
  makeFetchTransport: (options: unknown) => mockMakeFetchTransport(options),
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

  it('sends through the scrubbing transport', async () => {
    const options = loadOn('/registrar/students');
    expect(typeof options.transport).toBe('function');
    const transport = options.transport!({});
    expect(mockMakeFetchTransport).toHaveBeenCalled();
    // A recording the scrubber cannot read is dropped before the SDK's own transport sees it.
    const base = mockMakeFetchTransport.mock.results[mockMakeFetchTransport.mock.results.length - 1].value as { send: jest.Mock };
    await (transport.send as (e: unknown) => Promise<unknown>)([{}, [[{ type: 'replay_recording' }, new Uint8Array([1])]]]);
    expect(base.send).not.toHaveBeenCalled();
  });

  it('sets up no replay at all on the sign-in pages or the platform-admin area', () => {
    for (const pathname of ['/login', '/reset-password', '/super-admin/security']) {
      const options = loadOn(pathname);
      expect({ pathname, replay: mockReplayIntegration.mock.calls.length, integrations: options.integrations })
        .toEqual({ pathname, replay: 0, integrations: [] });
    }
  });
});
