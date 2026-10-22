'use strict';
// Test for OpenRouter provider data-collection opt-out behavior.

const { createOpenRouterProvider } = require('../src/platform/provider/openrouter');

describe('OpenRouter provider data-collection privacy', () => {
  let capturedBody;

  const fakeFetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    // Return a valid SSE stream with content and [DONE]
    return new Response(
      'data: {"choices":[{"delta":{"content":"test"}}]}\n\n' +
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n' +
      'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
  };

  const baseConfig = {
    AI_API_KEY: 'test-key',
    AI_REQUEST_TIMEOUT_MS: 5000,
  };

  afterEach(() => {
    capturedBody = undefined;
  });

  test('defaults to data_collection: deny and usage.include: true', async () => {
    // Ensure env var is not set
    const prev = process.env.AI_ALLOW_DATA_COLLECTION;
    delete process.env.AI_ALLOW_DATA_COLLECTION;

    const provider = createOpenRouterProvider({ config: baseConfig, fetchImpl: fakeFetch });
    await provider.generate({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });

    expect(capturedBody.provider.data_collection).toBe('deny');
    expect(capturedBody.usage.include).toBe(true);

    if (prev !== undefined) process.env.AI_ALLOW_DATA_COLLECTION = prev;
  });

  test('allows data_collection when AI_ALLOW_DATA_COLLECTION=true', async () => {
    const prev = process.env.AI_ALLOW_DATA_COLLECTION;
    process.env.AI_ALLOW_DATA_COLLECTION = 'true';

    const provider = createOpenRouterProvider({ config: baseConfig, fetchImpl: fakeFetch });
    await provider.generate({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });

    expect(capturedBody.provider.data_collection).toBe('allow');
    expect(capturedBody.usage.include).toBe(true);

    if (prev !== undefined) process.env.AI_ALLOW_DATA_COLLECTION = prev;
    else delete process.env.AI_ALLOW_DATA_COLLECTION;
  });

  test('allows data_collection when AI_ALLOW_DATA_COLLECTION=TRUE (case-insensitive)', async () => {
    const prev = process.env.AI_ALLOW_DATA_COLLECTION;
    process.env.AI_ALLOW_DATA_COLLECTION = 'TRUE';

    const provider = createOpenRouterProvider({ config: baseConfig, fetchImpl: fakeFetch });
    await provider.generate({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });

    expect(capturedBody.provider.data_collection).toBe('allow');
    expect(capturedBody.usage.include).toBe(true);

    if (prev !== undefined) process.env.AI_ALLOW_DATA_COLLECTION = prev;
    else delete process.env.AI_ALLOW_DATA_COLLECTION;
  });

  test('denies data_collection when AI_ALLOW_DATA_COLLECTION=false', async () => {
    const prev = process.env.AI_ALLOW_DATA_COLLECTION;
    process.env.AI_ALLOW_DATA_COLLECTION = 'false';

    const provider = createOpenRouterProvider({ config: baseConfig, fetchImpl: fakeFetch });
    await provider.generate({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });

    expect(capturedBody.provider.data_collection).toBe('deny');
    expect(capturedBody.usage.include).toBe(true);

    if (prev !== undefined) process.env.AI_ALLOW_DATA_COLLECTION = prev;
    else delete process.env.AI_ALLOW_DATA_COLLECTION;
  });
});