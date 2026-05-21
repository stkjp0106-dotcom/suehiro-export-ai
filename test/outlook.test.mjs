import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInboxDeltaUrl,
  buildDelegatedAuthUrl,
  createReplyDraft,
  exchangeDelegatedCodeForTokens,
  fetchMessageDelta,
  getGraphAccessToken,
  sendDraft,
  updateDraftBody
} from '../src/graph.mjs';
import { buildDraftHtml, buildReplyDraftInput, createOutlookReplyDraft } from '../src/outlook-ai.mjs';
import {
  getOutlookMonitorConfig,
  pollOutlookMailbox
} from '../src/outlook-monitor.mjs';

test('getGraphAccessToken uses Microsoft client credentials flow', async () => {
  const calls = [];
  const token = await getGraphAccessToken(
    { tenantId: 'tenant-id', clientId: 'client-id', clientSecret: 'client-secret' },
    async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ access_token: 'graph-token' })
      };
    }
  );

  assert.equal(token, 'graph-token');
  assert.match(calls[0].url, /login\.microsoftonline\.com\/tenant-id/);
  assert.match(calls[0].options.body.toString(), /grant_type=client_credentials/);
  assert.match(calls[0].options.body.toString(), /scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/);
});

test('buildInboxDeltaUrl targets the mailbox inbox delta endpoint', () => {
  const url = buildInboxDeltaUrl('sales@suehirotrd.com');
  assert.match(url, /\/users\/sales%40suehirotrd\.com\/mailFolders\/inbox\/messages\/delta/);
  assert.match(url, /changeType=created/);
});

test('buildDelegatedAuthUrl creates a Microsoft consent URL', () => {
  const url = new URL(buildDelegatedAuthUrl(
    { tenantId: 'common', clientId: 'client-id' },
    'http://localhost:3001/callback',
    'state-123'
  ));

  assert.equal(url.hostname, 'login.microsoftonline.com');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3001/callback');
  assert.match(url.searchParams.get('scope'), /offline_access/);
  assert.match(url.searchParams.get('scope'), /Mail\.ReadWrite/);
});

test('exchangeDelegatedCodeForTokens posts authorization code grant', async () => {
  const calls = [];
  const tokens = await exchangeDelegatedCodeForTokens(
    { tenantId: 'common', clientId: 'client-id', clientSecret: 'client-secret' },
    'auth-code',
    'http://localhost:3001/callback',
    async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ access_token: 'access', refresh_token: 'refresh' })
      };
    }
  );

  assert.equal(tokens.refresh_token, 'refresh');
  assert.match(calls[0].url, /login\.microsoftonline\.com\/common/);
  assert.match(calls[0].options.body.toString(), /grant_type=authorization_code/);
});

test('getGraphAccessToken uses refresh token when provided', async () => {
  const calls = [];
  const token = await getGraphAccessToken(
    {
      tenantId: 'common',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token'
    },
    async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ access_token: 'delegated-access' })
      };
    }
  );

  assert.equal(token, 'delegated-access');
  assert.match(calls[0].options.body.toString(), /grant_type=refresh_token/);
});

test('fetchMessageDelta follows nextLink and returns deltaLink', async () => {
  const calls = [];
  const result = await fetchMessageDelta(
    'me',
    'graph-token',
    {},
    {
      fetchImpl: async (url) => {
        calls.push(url);
        if (calls.length === 1) {
          return {
            ok: true,
            json: async () => ({
              value: [{ id: 'message-1', subject: 'Hello' }],
              '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page'
            })
          };
        }

        return {
          ok: true,
          json: async () => ({
            value: [{ id: 'message-2', subject: 'Hi', isDraft: true }],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-token'
          })
        };
      }
    }
  );

  assert.match(calls[0], /\/me\/mailFolders\/inbox\/messages\/delta/);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].id, 'message-1');
  assert.equal(result.deltaLink, 'https://graph.microsoft.com/v1.0/delta-token');
});

test('createReplyDraft and updateDraftBody call draft endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ id: 'draft-id' })
    };
  };

  const draft = await createReplyDraft('sales@suehirotrd.com', 'message-id', 'graph-token', fetchImpl);
  await updateDraftBody('sales@suehirotrd.com', draft.id, '<p>Hello</p>', 'graph-token', fetchImpl);

  assert.match(calls[0].url, /messages\/message-id\/createReply$/);
  assert.equal(calls[0].options.method, 'POST');
  assert.match(calls[1].url, /messages\/draft-id$/);
  assert.equal(calls[1].options.method, 'PATCH');
  assert.equal(JSON.parse(calls[1].options.body).body.content, '<p>Hello</p>');
});

test('sendDraft is isolated for future YES-to-send flow', async () => {
  const calls = [];
  await sendDraft('sales@suehirotrd.com', 'draft-id', 'graph-token', async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 204 };
  });

  assert.match(calls[0].url, /messages\/draft-id\/send$/);
  assert.equal(calls[0].options.method, 'POST');
});

test('createOutlookReplyDraft asks OpenAI for an email body only', async () => {
  const calls = [];
  const message = {
    subject: 'Quotation request',
    bodyPreview: 'Please send price.',
    body: { content: 'Please send price for beef tongue.' },
    from: { emailAddress: { name: 'Buyer', address: 'buyer@example.com' } }
  };

  const reply = await createOutlookReplyDraft(
    message,
    { apiKey: 'openai-key', model: 'test-model' },
    async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ output_text: 'Thank you. We will confirm and reply.' })
      };
    }
  );

  assert.equal(reply, 'Thank you. We will confirm and reply.');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'test-model');
  assert.match(body.input, /Quotation request/);
  assert.match(body.instructions, /Do not invent prices/);
});

test('buildDraftHtml marks the content as an AI draft', () => {
  const html = buildDraftHtml('Hello\nWorld');
  assert.match(html, /AI/);
  assert.match(html, /<br>/);
});

test('pollOutlookMailbox creates a draft once per message', async () => {
  const calls = [];
  const savedStates = [];
  const config = getOutlookMonitorConfig({
    OUTLOOK_MAILBOX: 'sales@suehirotrd.com',
    OUTLOOK_STATE_PATH: 'unused-state.json',
    OPENAI_API_KEY: 'openai-key',
    OPENAI_MODEL: 'test-model',
    MICROSOFT_TENANT_ID: 'tenant-id',
    MICROSOFT_CLIENT_ID: 'client-id',
    MICROSOFT_CLIENT_SECRET: 'client-secret'
  });
  const state = { initialized: true, deltaLink: '', processedMessageIds: [] };
  const logger = { info() {}, error() {} };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });

    if (String(url).includes('login.microsoftonline.com')) {
      return { ok: true, json: async () => ({ access_token: 'graph-token' }) };
    }

    if (String(url).includes('/messages/delta')) {
      return {
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'message-id',
              subject: 'Need quote',
              bodyPreview: 'Please quote.',
              body: { content: 'Please quote beef tongue.' },
              from: { emailAddress: { address: 'buyer@example.com' } }
            }
          ],
          '@odata.deltaLink': 'delta-link'
        })
      };
    }

    if (String(url).includes('api.openai.com')) {
      return { ok: true, json: async () => ({ output_text: 'Draft reply' }) };
    }

    if (String(url).endsWith('/createReply')) {
      return { ok: true, json: async () => ({ id: 'draft-id' }) };
    }

    return { ok: true, json: async () => ({ id: 'draft-id' }) };
  };

  const result = await pollOutlookMailbox(
    { ...config, statePath: 'unused-state.json' },
    {
      logger,
      fetchImpl,
      loadState: () => state,
      saveState: (_path, nextState) => savedStates.push(nextState)
    }
  );

  assert.equal(result.processed, 1);
  assert.equal(savedStates.at(-1).deltaLink, 'delta-link');
  assert(savedStates.at(-1).processedMessageIds.includes('message-id'));
  assert(calls.some((call) => String(call.url).endsWith('/createReply')));
  assert(calls.some((call) => call.options?.method === 'PATCH'));
});

test('pollOutlookMailbox baselines existing mail on first run by default', async () => {
  const savedStates = [];
  const config = getOutlookMonitorConfig({
    OUTLOOK_MAILBOX: 'sales@suehirotrd.com',
    OUTLOOK_STATE_PATH: 'unused-state.json',
    OPENAI_API_KEY: 'openai-key',
    MICROSOFT_TENANT_ID: 'tenant-id',
    MICROSOFT_CLIENT_ID: 'client-id',
    MICROSOFT_CLIENT_SECRET: 'client-secret'
  });
  const logger = { info() {}, error() {} };
  const fetchImpl = async (url) => {
    if (String(url).includes('login.microsoftonline.com')) {
      return { ok: true, json: async () => ({ access_token: 'graph-token' }) };
    }

    return {
      ok: true,
      json: async () => ({
        value: [{ id: 'old-message-id', subject: 'Old message' }],
        '@odata.deltaLink': 'delta-link'
      })
    };
  };

  const result = await pollOutlookMailbox(config, {
    logger,
    fetchImpl,
    loadState: () => ({ initialized: false, deltaLink: '', processedMessageIds: [] }),
    saveState: (_path, nextState) => savedStates.push(nextState)
  });

  assert.equal(result.processed, 0);
  assert.equal(result.baselineOnly, true);
  assert.equal(savedStates.at(-1).initialized, true);
  assert.equal(savedStates.at(-1).deltaLink, 'delta-link');
});
