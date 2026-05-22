import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProspectLineReport,
  buildProspectSearchInput,
  discoverProspects,
  getProspectMonitorConfig,
  parseProspects,
  runProspectSearch,
  validateProspectMonitorConfig
} from '../src/prospect-monitor.mjs';

test('getProspectMonitorConfig reads scheduling and search settings', () => {
  const config = getProspectMonitorConfig({
    OPENAI_API_KEY: 'openai-key',
    OPENAI_MODEL: 'test-model',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REFRESH_TOKEN: 'refresh-token',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    LINE_REPORT_TO_ID: 'line-user-id',
    PROSPECT_INTERVAL_HOURS: '12',
    PROSPECT_MAX_PROSPECTS: '3',
    PROSPECT_TARGET_MARKETS: 'Hong Kong',
    PROSPECT_PRODUCTS: 'beef tongue',
    PROSPECT_COMPANY_PITCH: 'We propose Japanese wagyu and coordinate export documents.'
  });

  assert.equal(config.intervalHours, 12);
  assert.equal(config.maxProspects, 3);
  assert.equal(config.targetMarkets, 'Hong Kong');
  assert.equal(config.products, 'beef tongue');
  assert.equal(config.companyPitch, 'We propose Japanese wagyu and coordinate export documents.');
  assert.deepEqual(validateProspectMonitorConfig(config), []);
});

test('buildProspectSearchInput includes prior prospects', () => {
  const input = buildProspectSearchInput(
    { targetMarkets: 'Hong Kong', products: 'wagyu', maxProspects: 5 },
    { seenProspects: ['https://used.example.com'] }
  );

  assert.match(input, /Hong Kong/);
  assert.match(input, /wagyu/);
  assert.match(input, /Japanese wagyu beef/);
  assert.match(input, /factory\/processing/);
  assert.match(input, /used\.example\.com/);
});

test('parseProspects normalizes prospects with public emails', () => {
  const prospects = parseProspects(JSON.stringify({
    prospects: [
      {
        company: 'Importer Co',
        country: 'Hong Kong',
        website: 'https://importer.example',
        email: 'buyer@importer.example',
        contact_url: 'https://importer.example/contact',
        evidence: 'Imports premium meat.',
        source_urls: ['https://importer.example'],
        draft_subject: 'Japanese wagyu export inquiry',
        draft_body: 'Hello, we export Japanese wagyu.'
      },
      { company: 'No Email Co', website: 'https://no-email.example' }
    ]
  }));

  assert.equal(prospects.length, 1);
  assert.equal(prospects[0].company, 'Importer Co');
  assert.equal(prospects[0].email, 'buyer@importer.example');
});

test('discoverProspects uses OpenAI web search tool', async () => {
  const prospects = await discoverProspects(
    {
      openaiApiKey: 'openai-key',
      openaiModel: 'test-model',
      targetMarkets: 'Hong Kong',
      products: 'wagyu',
      maxProspects: 5
    },
    { seenProspects: [] },
    async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.deepEqual(body.tools, [{ type: 'web_search_preview' }]);
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.name, 'prospect_discovery');
      assert.match(body.instructions, /personalized to the prospect/);
      assert.match(body.instructions, /SUEHIRO would like to propose Japanese wagyu beef/);
      assert.match(body.instructions, /factory\/processing coordination/);
      assert.match(body.input, /Hong Kong/);
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            prospects: [
              {
                company: 'Importer Co',
                country: 'Hong Kong',
                website: 'https://importer.example',
                email: 'buyer@importer.example',
                contact_url: 'https://importer.example/contact',
                evidence: 'Imports premium meat.',
                source_urls: ['https://importer.example'],
                draft_subject: 'Japanese wagyu export inquiry',
                draft_body: 'Hello, we export Japanese wagyu.'
              }
            ]
          })
        })
      };
    }
  );

  assert.equal(prospects.length, 1);
  assert.equal(prospects[0].company, 'Importer Co');
});

test('runProspectSearch creates drafts and reports to LINE', async () => {
  const calls = [];
  const config = getProspectMonitorConfig({
    OPENAI_API_KEY: 'openai-key',
    OPENAI_MODEL: 'test-model',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REFRESH_TOKEN: 'refresh-token',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    LINE_REPORT_TO_ID: 'line-user-id',
    PROSPECT_MAX_PROSPECTS: '1'
  });

  const result = await runProspectSearch(config, {
    logger: { info() {}, error() {} },
    loadState: () => ({ lastRunAt: '', seenProspects: [] }),
    saveState: () => {},
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('oauth2.googleapis.com')) {
        return { ok: true, json: async () => ({ access_token: 'gmail-token' }) };
      }
      if (String(url).includes('api.openai.com')) {
        return {
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              prospects: [
                {
                  company: 'Importer Co',
                  country: 'Hong Kong',
                  website: 'https://importer.example',
                  email: 'buyer@importer.example',
                  contact_url: 'https://importer.example/contact',
                  evidence: 'Imports premium meat.',
                  source_urls: ['https://importer.example'],
                  draft_subject: 'Japanese wagyu export inquiry',
                  draft_body: 'Hello, we export Japanese wagyu.'
                }
              ]
            })
          })
        };
      }
      if (String(url).endsWith('/settings/sendAs')) {
        return {
          ok: true,
          json: async () => ({
            sendAs: [{ sendAsEmail: 'sales@suehirotrd.com', isPrimary: true, signature: '<p>Configured Suetore signature</p>' }]
          })
        };
      }
      if (String(url).endsWith('/drafts')) {
        return { ok: true, json: async () => ({ id: 'draft-id' }) };
      }
      if (String(url).includes('api.line.me')) {
        return { ok: true };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(result.drafts.length, 1);
  assert(calls.some((call) => call.url.endsWith('/drafts')));
  assert(calls.some((call) => call.url === 'https://api.line.me/v2/bot/message/push'));
});

test('buildProspectLineReport asks for human review before sending', () => {
  const report = buildProspectLineReport([
    {
      prospect: {
        company: 'Importer Co',
        country: 'Hong Kong',
        email: 'buyer@importer.example',
        website: 'https://importer.example',
        evidence: 'Imports premium meat.'
      },
      draftId: 'draft-id'
    }
  ]);

  assert.match(report, /輸入者候補/);
  assert.match(report, /Importer Co/);
  assert.match(report, /自動送信はしていません/);
});
