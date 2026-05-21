import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAIInput, createSuehiroReply } from '../src/openai.mjs';

test('createSuehiroReply sends the LINE text to OpenAI and returns output_text', async () => {
  const calls = [];
  const requestText = '\u9999\u6e2f\u5411\u3051\u306b\u725b\u30bf\u30f3\u306e\u55b6\u696d\u6587\u3092\u4f5c\u3063\u3066';
  const responseText = '\u9999\u6e2f\u5411\u3051\u306e\u55b6\u696d\u6587\u3067\u3059\u3002';

  const reply = await createSuehiroReply(
    requestText,
    { apiKey: 'openai-key', model: 'test-model' },
    async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ output_text: responseText })
      };
    }
  );

  assert.equal(reply, responseText);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer openai-key');

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'test-model');
  assert(body.input.includes(`User request:\n${requestText}`));
  assert.match(body.instructions, /SUEHIRO/);
});

test('buildOpenAIInput includes local knowledge base context', () => {
  const requestText = '\u4fa1\u683c\u8868\u898b\u3066';
  const input = buildOpenAIInput(requestText, '01_PRODUCTS/Gyutan.md\nMOQ: \u8981\u78ba\u8a8d');

  assert.match(input, /Local SUEHIRO knowledge base context/);
  assert(input.includes('01_PRODUCTS/Gyutan.md'));
  assert(input.includes(`User request:\n${requestText}`));
});
