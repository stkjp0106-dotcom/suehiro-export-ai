import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  buildReceivedReply,
  handleLineWebhook,
  parseLineMessageText,
  verifyLineSignature
} from '../src/line.mjs';

const DEFAULT_REPLY_TEXT = '\u53d7\u4fe1\u3057\u307e\u3057\u305f\u3002\u78ba\u8a8d\u3057\u3066\u8fd4\u4fe1\u3057\u307e\u3059\u3002';

test('verifyLineSignature accepts a valid LINE signature', () => {
  const body = '{"events":[]}';
  const secret = 'secret';
  const signature = createHmac('sha256', secret).update(body).digest('base64');

  assert.equal(verifyLineSignature(body, signature, secret), true);
});

test('verifyLineSignature rejects an invalid LINE signature', () => {
  assert.equal(verifyLineSignature('{"events":[]}', 'bad-signature', 'secret'), false);
});

test('buildReceivedReply creates the first LINE reply message', () => {
  assert.deepEqual(buildReceivedReply('reply-token'), {
    replyToken: 'reply-token',
    messages: [
      {
        type: 'text',
        text: DEFAULT_REPLY_TEXT
      }
    ]
  });
});

test('handleLineWebhook replies to message events', async () => {
  const body = JSON.stringify({
    events: [
      {
        type: 'message',
        replyToken: 'reply-token',
        message: { type: 'text', text: 'hello' }
      }
    ]
  });
  const secret = 'secret';
  const signature = createHmac('sha256', secret).update(body).digest('base64');
  const calls = [];

  const result = await handleLineWebhook(
    body,
    { 'x-line-signature': signature },
    { channelSecret: secret, channelAccessToken: 'access-token' },
    async (url, options) => {
      calls.push({ url, options });
      return { ok: true };
    }
  );

  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/reply');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer access-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), buildReceivedReply('reply-token'));
});

test('handleLineWebhook can reply with generated text', async () => {
  const body = JSON.stringify({
    events: [
      {
        type: 'message',
        replyToken: 'reply-token',
        message: { type: 'text', text: 'hello' }
      }
    ]
  });
  const secret = 'secret';
  const signature = createHmac('sha256', secret).update(body).digest('base64');
  const calls = [];

  await handleLineWebhook(
    body,
    { 'x-line-signature': signature },
    {
      channelSecret: secret,
      channelAccessToken: 'access-token',
      createReply: async (text) => `AI: ${text}`
    },
    async (url, options) => {
      calls.push({ url, options });
      return { ok: true };
    }
  );

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    replyToken: 'reply-token',
    messages: [{ type: 'text', text: 'AI: hello' }]
  });
});

test('handleLineWebhook sends a friendly message when reply generation fails', async () => {
  const body = JSON.stringify({
    events: [
      {
        type: 'message',
        replyToken: 'reply-token',
        message: { type: 'text', text: 'hello' }
      }
    ]
  });
  const secret = 'secret';
  const signature = createHmac('sha256', secret).update(body).digest('base64');
  const calls = [];

  await handleLineWebhook(
    body,
    { 'x-line-signature': signature },
    {
      channelSecret: secret,
      channelAccessToken: 'access-token',
      createReply: async () => {
        throw new Error('OpenAI response failed: 429 insufficient_quota');
      }
    },
    async (url, options) => {
      calls.push({ url, options });
      return { ok: true };
    }
  );

  const reply = JSON.parse(calls[0].options.body);
  assert.match(reply.messages[0].text, /OpenAI API/);
  assert(reply.messages[0].text.includes('\u8a2d\u5b9a'));
});

test('parseLineMessageText returns text from LINE text message events', () => {
  const text = '\u9999\u6e2f\u5411\u3051\u306b\u725b\u30bf\u30f3\u306e\u55b6\u696d\u6587\u3092\u4f5c\u3063\u3066';
  assert.equal(
    parseLineMessageText({
      type: 'message',
      message: { type: 'text', text }
    }),
    text
  );
});
