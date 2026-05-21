import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGmailDraftHtml,
  buildGmailReplyDraftInput,
  buildReplyMime,
  createGmailReplyDraft,
  getGmailAccessToken,
  listGmailHistory,
  normalizeGmailMessage
} from '../src/gmail.mjs';
import {
  createGmailAiReplyDraft,
  getGmailMonitorConfig,
  pollGmailMailbox
} from '../src/gmail-monitor.mjs';

test('getGmailAccessToken refreshes with GOOGLE_REFRESH_TOKEN', async () => {
  const token = await getGmailAccessToken(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token'
    },
    async (url, options) => {
      assert.match(String(url), /oauth2\.googleapis\.com\/token/);
      assert.match(options.body.toString(), /grant_type=refresh_token/);
      return { ok: true, json: async () => ({ access_token: 'gmail-token' }) };
    }
  );

  assert.equal(token, 'gmail-token');
});

test('listGmailHistory returns inbox message additions and next historyId', async () => {
  const calls = [];
  const result = await listGmailHistory('100', 'gmail-token', {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          historyId: '120',
          history: [
            {
              messagesAdded: [
                { message: { id: 'message-1', threadId: 'thread-1' } },
                { message: { id: 'message-1', threadId: 'thread-1' } }
              ]
            }
          ]
        })
      };
    }
  });

  assert.match(calls[0], /startHistoryId=100/);
  assert.match(calls[0], /historyTypes=messageAdded/);
  assert.equal(result.historyId, '120');
  assert.deepEqual(result.messages.map((message) => message.id), ['message-1']);
});

test('normalizeGmailMessage extracts headers and text body', () => {
  const normalized = normalizeGmailMessage({
    id: 'message-id',
    threadId: 'thread-id',
    snippet: 'Hello',
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'Subject', value: 'Need quote' },
        { name: 'From', value: 'Buyer <buyer@example.com>' },
        { name: 'Message-ID', value: '<abc@example.com>' }
      ],
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from('Please quote beef tongue.', 'utf8').toString('base64url') }
        }
      ]
    }
  });

  assert.equal(normalized.subject, 'Need quote');
  assert.equal(normalized.from, 'Buyer <buyer@example.com>');
  assert.equal(normalized.bodyText, 'Please quote beef tongue.');
  assert.equal(normalized.messageId, '<abc@example.com>');
});

test('buildReplyMime creates a Gmail raw reply message', () => {
  const raw = buildReplyMime(
    {
      from: 'Buyer <buyer@example.com>',
      subject: '見積依頼',
      messageId: '<abc@example.com>',
      references: '<root@example.com>'
    },
    '<p>確認します。</p>'
  );
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

  assert.match(decoded, /To: buyer@example\.com/);
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/);
  assert.match(decoded, /In-Reply-To: <abc@example\.com>/);
  assert.match(decoded, /<p>確認します。<\/p>/);
});

test('createGmailReplyDraft calls Gmail drafts endpoint', async () => {
  const draft = await createGmailReplyDraft(
    {
      from: 'Buyer <buyer@example.com>',
      subject: 'Need quote',
      threadId: 'thread-id',
      messageId: '<abc@example.com>'
    },
    '<p>Draft</p>',
    'gmail-token',
    async (url, options) => {
      assert.match(String(url), /\/gmail\/v1\/users\/me\/drafts$/);
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      assert.equal(body.message.threadId, 'thread-id');
      assert(body.message.raw);
      return { ok: true, json: async () => ({ id: 'draft-id' }) };
    }
  );

  assert.equal(draft.id, 'draft-id');
});

test('createGmailAiReplyDraft asks OpenAI for an email body only', async () => {
  const message = {
    from: 'Buyer <buyer@example.com>',
    subject: 'Quotation request',
    date: 'today',
    snippet: 'Please send price.',
    bodyText: 'Please send price for beef tongue.'
  };

  const reply = await createGmailAiReplyDraft(
    message,
    { apiKey: 'openai-key', model: 'test-model' },
    async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'test-model');
      assert.match(body.input, /Quotation request/);
      assert.match(body.instructions, /Do not invent prices/);
      return { ok: true, json: async () => ({ output_text: 'Thank you. We will confirm and reply.' }) };
    }
  );

  assert.equal(reply, 'Thank you. We will confirm and reply.');
});

test('buildGmailReplyDraftInput and buildGmailDraftHtml format content', () => {
  const input = buildGmailReplyDraftInput({
    from: 'Buyer <buyer@example.com>',
    subject: 'Hello',
    bodyText: 'Body'
  });
  const html = buildGmailDraftHtml('Hello\nWorld');

  assert.match(input, /Incoming email/);
  assert.match(input, /Buyer/);
  assert.match(html, /AI返信案/);
  assert.match(html, /<br>/);
  assert.match(html, /stststststststststststststststststststststst/);
  assert.match(html, /SUEHIRO TRADING Co\., Ltd\./);
  assert.match(html, /https:\/\/suehirotrd\.com\/sales\//);
  assert.match(html, /Tokyo, Japan\. 111-0032/);
});

test('pollGmailMailbox saves first-run baseline from profile', async () => {
  const savedStates = [];
  const config = getGmailMonitorConfig({
    GMAIL_MAILBOX: 'sales@suehirotrd.com',
    GMAIL_STATE_PATH: 'unused-state.json',
    OPENAI_API_KEY: 'openai-key',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REFRESH_TOKEN: 'refresh-token'
  });
  const logger = { info() {}, error() {} };

  const result = await pollGmailMailbox(config, {
    logger,
    loadState: () => ({ initialized: false, historyId: '', processedMessageIds: [] }),
    saveState: (_path, nextState) => savedStates.push(nextState),
    fetchImpl: async (url) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return { ok: true, json: async () => ({ access_token: 'gmail-token' }) };
      }

      return { ok: true, json: async () => ({ emailAddress: 'sales@suehirotrd.com', historyId: '500' }) };
    }
  });

  assert.equal(result.baselineOnly, true);
  assert.equal(savedStates.at(-1).historyId, '500');
});

test('pollGmailMailbox creates a draft for a new inbox message', async () => {
  const calls = [];
  const savedStates = [];
  const config = getGmailMonitorConfig({
    GMAIL_MAILBOX: 'sales@suehirotrd.com',
    GMAIL_STATE_PATH: 'unused-state.json',
    OPENAI_API_KEY: 'openai-key',
    OPENAI_MODEL: 'test-model',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REFRESH_TOKEN: 'refresh-token'
  });
  const logger = { info() {}, error() {} };

  const result = await pollGmailMailbox(config, {
    logger,
    loadState: () => ({ initialized: true, historyId: '100', processedMessageIds: [] }),
    saveState: (_path, nextState) => savedStates.push(nextState),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('oauth2.googleapis.com')) {
        return { ok: true, json: async () => ({ access_token: 'gmail-token' }) };
      }
      if (String(url).includes('/history')) {
        return {
          ok: true,
          json: async () => ({
            historyId: '101',
            history: [{ messagesAdded: [{ message: { id: 'message-id' } }] }]
          })
        };
      }
      if (String(url).includes('/messages/message-id')) {
        return {
          ok: true,
          json: async () => ({
            id: 'message-id',
            threadId: 'thread-id',
            labelIds: ['INBOX'],
            snippet: 'Please quote.',
            payload: {
              headers: [
                { name: 'Subject', value: 'Need quote' },
                { name: 'From', value: 'Buyer <buyer@example.com>' },
                { name: 'Message-ID', value: '<abc@example.com>' }
              ],
              body: { data: Buffer.from('Please quote beef tongue.', 'utf8').toString('base64url') },
              mimeType: 'text/plain'
            }
          })
        };
      }
      if (String(url).includes('api.openai.com')) {
        return { ok: true, json: async () => ({ output_text: 'Draft reply' }) };
      }
      if (String(url).endsWith('/drafts')) {
        return { ok: true, json: async () => ({ id: 'draft-id' }) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(result.processed, 1);
  assert.equal(savedStates.at(-1).historyId, '101');
  assert(savedStates.at(-1).processedMessageIds.includes('message-id'));
  assert(calls.some((call) => call.url.endsWith('/drafts')));
});
