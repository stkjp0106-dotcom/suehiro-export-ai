import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addGmailLabels,
  buildGmailDraftHtml,
  buildGmailReplyDraftInput,
  buildReplyMime,
  buildOutboundMime,
  createGmailLabel,
  createGmailOutboundDraft,
  createGmailReplyDraft,
  findGmailLabelId,
  getGmailAccessToken,
  GMAIL_SCOPES,
  listGmailHistory,
  normalizeGmailMessage,
  sendGmailDraft
} from '../src/gmail.mjs';
import {
  buildGmailLineReport,
  classifyGmailInquiry,
  createGmailAiReplyDraft,
  createGmailAiMailSummary,
  getGmailMonitorConfig,
  labelGmailDraft,
  notifyLineAboutGmailDraft,
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

test('GMAIL_SCOPES includes Drive readonly for shared Google token', () => {
  assert.match(GMAIL_SCOPES, /gmail\.readonly/);
  assert.match(GMAIL_SCOPES, /gmail\.compose/);
  assert.match(GMAIL_SCOPES, /gmail\.modify/);
  assert.match(GMAIL_SCOPES, /drive\.readonly/);
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

test('findGmailLabelId locates the AI Reply label', async () => {
  const labelId = await findGmailLabelId('AI Reply', 'gmail-token', async (url) => {
    assert.match(String(url), /\/gmail\/v1\/users\/me\/labels$/);
    return {
      ok: true,
      json: async () => ({
        labels: [
          { id: 'Label_1', name: 'Customers' },
          { id: 'Label_2', name: 'AI Reply' }
        ]
      })
    };
  });

  assert.equal(labelId, 'Label_2');
});

test('addGmailLabels calls Gmail modify endpoint', async () => {
  const result = await addGmailLabels('message-id', ['Label_2'], 'gmail-token', async (url, options) => {
    assert.match(String(url), /\/messages\/message-id\/modify$/);
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body).addLabelIds, ['Label_2']);
    return { ok: true, json: async () => ({ id: 'message-id', labelIds: ['DRAFT', 'Label_2'] }) };
  });

  assert.deepEqual(result.labelIds, ['DRAFT', 'Label_2']);
});

test('createGmailLabel creates a visible Gmail label', async () => {
  const labelId = await createGmailLabel('AI Reply', 'gmail-token', async (url, options) => {
    assert.match(String(url), /\/gmail\/v1\/users\/me\/labels$/);
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {
      name: 'AI Reply',
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    });
    return { ok: true, json: async () => ({ id: 'Label_3', name: 'AI Reply' }) };
  });

  assert.equal(labelId, 'Label_3');
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

test('createGmailOutboundDraft creates a new cold outreach draft', async () => {
  const draft = await createGmailOutboundDraft(
    {
      to: 'buyer@example.com',
      subject: 'Japanese wagyu export inquiry',
      htmlBody: '<p>Hello</p>'
    },
    'gmail-token',
    async (url, options) => {
      assert.match(String(url), /\/gmail\/v1\/users\/me\/drafts$/);
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      const decoded = Buffer.from(body.message.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      assert.match(decoded, /To: buyer@example\.com/);
      assert.match(decoded, /Subject: Japanese wagyu export inquiry/);
      assert.match(decoded, /<p>Hello<\/p>/);
      return { ok: true, json: async () => ({ id: 'outbound-draft-id' }) };
    }
  );

  assert.equal(draft.id, 'outbound-draft-id');
});

test('sendGmailDraft calls Gmail drafts send endpoint', async () => {
  const message = await sendGmailDraft('draft-id', 'gmail-token', async (url, options) => {
    assert.match(String(url), /\/gmail\/v1\/users\/me\/drafts\/send$/);
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { id: 'draft-id' });
    return { ok: true, json: async () => ({ id: 'sent-message-id' }) };
  });

  assert.equal(message.id, 'sent-message-id');
});

test('buildOutboundMime encodes non-ascii subjects', () => {
  const raw = buildOutboundMime({ to: 'buyer@example.com', subject: '和牛のご提案' }, '<p>Hello</p>');
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/);
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

test('createGmailAiMailSummary asks OpenAI for a short Japanese summary', async () => {
  const summary = await createGmailAiMailSummary(
    {
      from: 'Buyer <buyer@example.com>',
      subject: 'Quotation request',
      bodyText: 'Please send price for beef tongue.'
    },
    { apiKey: 'openai-key', model: 'test-model' },
    async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'test-model');
      assert.match(body.input, /Quotation request/);
      assert.match(body.instructions, /Japanese/);
      return { ok: true, json: async () => ({ output_text: '牛タンの見積依頼。価格確認が必要。' }) };
    }
  );

  assert.equal(summary, '牛タンの見積依頼。価格確認が必要。');
});

test('classifyGmailInquiry parses new inquiry JSON', async () => {
  const classification = await classifyGmailInquiry(
    {
      from: 'Buyer <buyer@example.com>',
      subject: 'Quotation request',
      bodyText: 'Please send price for beef tongue.'
    },
    { apiKey: 'openai-key', model: 'test-model' },
    async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'test-model');
      assert.match(body.instructions, /classify incoming emails/);
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            is_new_inquiry: true,
            summary: '牛タンの見積依頼です。',
            reason: '価格確認を求める新規問い合わせです。'
          })
        })
      };
    }
  );

  assert.equal(classification.isNewInquiry, true);
  assert.equal(classification.summary, '牛タンの見積依頼です。');
  assert.equal(classification.reason, '価格確認を求める新規問い合わせです。');
});

test('classifyGmailInquiry safely rejects invalid JSON', async () => {
  const classification = await classifyGmailInquiry(
    { subject: 'Hello', bodyText: 'Body' },
    { apiKey: 'openai-key', model: 'test-model' },
    async () => ({ ok: true, json: async () => ({ output_text: 'not json' }) })
  );

  assert.equal(classification.isNewInquiry, false);
  assert.match(classification.reason, /JSON/);
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
  assert.doesNotMatch(html, /AI返信案/);
  assert.doesNotMatch(html, /送信前に必ず内容を確認/);
  assert.match(html, /<br>/);
  assert.match(html, /ststststststststststststststststststststststststststststst/);
  assert.match(html, /Takumi Sato -佐藤 拓海-/);
  assert.match(html, /SUEHIRO TRADING Co\., Ltd\./);
  assert.match(html, /Mob\/Whatsapp : \+81\(0\)9061407648/);
  assert.match(html, /https:\/\/suehirotrd\.com\/sales\//);
  assert.match(html, /1-13-5-C63 Asakusa, Taito-ku, Tokyo, Japan\. 111-0032/);
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
    GOOGLE_REFRESH_TOKEN: 'refresh-token',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    LINE_REPORT_TO_ID: 'line-user-id'
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
        const body = JSON.parse(options.body);
        if (body.instructions.includes('classify incoming emails')) {
          return {
            ok: true,
            json: async () => ({
              output_text: JSON.stringify({
                is_new_inquiry: true,
                summary: '牛タンの見積依頼です。',
                reason: '価格確認を求める新規の営業問い合わせです。'
              })
            })
          };
        }
        return { ok: true, json: async () => ({ output_text: 'Draft reply' }) };
      }
      if (String(url).endsWith('/drafts')) {
        return { ok: true, json: async () => ({ id: 'draft-id', message: { id: 'draft-message-id' } }) };
      }
      if (String(url).endsWith('/labels')) {
        return {
          ok: true,
          json: async () => ({ labels: [{ id: 'Label_2', name: 'AI Reply' }] })
        };
      }
      if (String(url).endsWith('/messages/draft-message-id/modify')) {
        return { ok: true, json: async () => ({ id: 'draft-message-id', labelIds: ['DRAFT', 'Label_2'] }) };
      }
      if (String(url).includes('api.line.me')) {
        return { ok: true };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(result.processed, 1);
  assert.equal(savedStates.at(-1).historyId, '101');
  assert(savedStates.at(-1).processedMessageIds.includes('message-id'));
  assert(calls.some((call) => call.url.endsWith('/drafts')));
  assert(calls.some((call) => call.url.endsWith('/labels')));
  assert(calls.some((call) => call.url.endsWith('/messages/draft-message-id/modify')));
  assert(calls.some((call) => call.url === 'https://api.line.me/v2/bot/message/push'));
});

test('pollGmailMailbox skips draft creation and LINE report for non-new inquiries', async () => {
  const calls = [];
  const config = getGmailMonitorConfig({
    GMAIL_MAILBOX: 'sales@suehirotrd.com',
    GMAIL_STATE_PATH: 'unused-state.json',
    OPENAI_API_KEY: 'openai-key',
    OPENAI_MODEL: 'test-model',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REFRESH_TOKEN: 'refresh-token',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    LINE_REPORT_TO_ID: 'line-user-id'
  });
  const logger = { info() {}, warn() {}, error() {} };

  const result = await pollGmailMailbox(config, {
    logger,
    loadState: () => ({ initialized: true, historyId: '100', processedMessageIds: [] }),
    saveState: () => {},
    fetchImpl: async (url, options = {}) => {
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
            snippet: 'Forwarder sales pitch.',
            payload: {
              headers: [
                { name: 'Subject', value: 'Logistics service proposal' },
                { name: 'From', value: 'Forwarder <sales@example.com>' }
              ],
              body: { data: Buffer.from('We would like to introduce our logistics service.', 'utf8').toString('base64url') },
              mimeType: 'text/plain'
            }
          })
        };
      }
      if (String(url).includes('api.openai.com')) {
        return {
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              is_new_inquiry: false,
              summary: '物流会社からの営業提案です。',
              reason: '顧客からの見積や商品問い合わせではありません。'
            })
          })
        };
      }
      if (String(url).includes('api.line.me')) {
        throw new Error('LINE should not be called for non-new inquiries');
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(result.processed, 1);
  assert(!calls.some((call) => call.url.endsWith('/drafts')));
  assert(!calls.some((call) => call.url === 'https://api.line.me/v2/bot/message/push'));
});

test('pollGmailMailbox creates AI Reply label when missing', async () => {
  const calls = [];
  const config = getGmailMonitorConfig({
    GMAIL_MAILBOX: 'sales@suehirotrd.com',
    GMAIL_STATE_PATH: 'unused-state.json',
    OPENAI_API_KEY: 'openai-key',
    OPENAI_MODEL: 'test-model',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REFRESH_TOKEN: 'refresh-token'
  });
  const logger = { info() {}, warn() {}, error() {} };

  const result = await pollGmailMailbox(config, {
    logger,
    loadState: () => ({ initialized: true, historyId: '100', processedMessageIds: [] }),
    saveState: () => {},
    fetchImpl: async (url, options = {}) => {
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
        const body = JSON.parse(options.body);
        if (body.instructions.includes('classify incoming emails')) {
          return {
            ok: true,
            json: async () => ({
              output_text: JSON.stringify({
                is_new_inquiry: true,
                summary: '牛タンの見積依頼です。',
                reason: '価格確認を求める新規の営業問い合わせです。'
              })
            })
          };
        }
        return { ok: true, json: async () => ({ output_text: 'Draft reply' }) };
      }
      if (String(url).endsWith('/drafts')) {
        return { ok: true, json: async () => ({ id: 'draft-id', message: { id: 'draft-message-id' } }) };
      }
      if (String(url).endsWith('/labels') && options.method === 'POST') {
        return { ok: true, json: async () => ({ id: 'Label_3', name: 'AI Reply' }) };
      }
      if (String(url).endsWith('/labels')) {
        return { ok: true, json: async () => ({ labels: [] }) };
      }
      if (String(url).endsWith('/messages/draft-message-id/modify')) {
        return { ok: true, json: async () => ({ id: 'draft-message-id', labelIds: ['DRAFT', 'Label_3'] }) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(result.processed, 1);
  assert(calls.some((call) => call.url.endsWith('/labels') && call.options.method === 'POST'));
  assert(calls.some((call) => call.url.endsWith('/messages/draft-message-id/modify')));
});

test('labelGmailDraft skips label errors without failing the message', async () => {
  const warnings = [];
  const result = await labelGmailDraft('draft-message-id', 'AI Reply', 'gmail-token', {
    logger: {
      info() {},
      warn: (message) => warnings.push(message)
    },
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith('/labels') && options.method === 'POST') {
        return { ok: false, text: async () => 'insufficient scope' };
      }
      if (String(url).endsWith('/labels')) {
        return { ok: true, json: async () => ({ labels: [] }) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(result, false);
  assert.match(warnings[0], /Gmail draft label skipped/);
});

test('buildGmailLineReport formats the new mail summary for LINE', () => {
  const report = buildGmailLineReport(
    {
      from: 'Buyer <buyer@example.com>',
      subject: 'Need quote',
      bodyText: 'Please quote beef tongue.\nWe need 20 cartons.'
    },
    { id: 'draft-id' },
    '牛タン20カートンの見積依頼。',
    {
      isNewInquiry: true,
      summary: '牛タン20カートンの見積依頼。',
      reason: '価格確認を求める新規問い合わせです。'
    }
  );

  assert.match(report, /メールを検知/);
  assert.match(report, /判定: 新規問い合わせ/);
  assert.match(report, /Buyer <buyer@example\.com>/);
  assert.match(report, /Need quote/);
  assert.match(report, /牛タン20カートンの見積依頼。/);
  assert.match(report, /価格確認を求める新規問い合わせ/);
  assert.match(report, /draft-id/);
});

test('notifyLineAboutGmailDraft skips when LINE report env is missing', async () => {
  const warnings = [];
  const result = await notifyLineAboutGmailDraft(
    { id: 'message-id', subject: 'Hello' },
    { id: 'draft-id' },
    { lineReport: {} },
    {
      logger: { info() {}, warn: (message) => warnings.push(message) },
      fetchImpl: async () => {
        throw new Error('LINE should not be called');
      }
    }
  );

  assert.equal(result, false);
  assert.match(warnings[0], /LINE mail report skipped/);
});
