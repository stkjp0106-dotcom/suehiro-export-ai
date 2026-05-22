import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProspectTargetProfileCommand,
  applyProspectTargetMarketsCommand,
  buildProspectLineReport,
  buildProspectSearchInput,
  classifyProspectLineCommand,
  discoverProspects,
  getEffectiveProspectTargetProfile,
  getEffectiveProspectTargetMarkets,
  getProspectMonitorConfig,
  parseProspectRunCommand,
  parseProspectLineCommandClassification,
  parseProspectTargetProfileCommand,
  parseProspectTargetMarketsCommand,
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
    PROSPECT_TARGET_PROFILE: 'Premium seafood importers with Japan import experience',
    PROSPECT_PRODUCTS: 'beef tongue',
    PROSPECT_COMPANY_PITCH: 'We propose Japanese wagyu and coordinate export documents.'
  });

  assert.equal(config.intervalHours, 12);
  assert.equal(config.maxProspects, 3);
  assert.equal(config.targetMarkets, 'Hong Kong');
  assert.equal(config.targetProfile, 'Premium seafood importers with Japan import experience');
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

test('buildProspectSearchInput uses target markets saved from LINE', () => {
  const input = buildProspectSearchInput(
    { targetMarkets: 'Hong Kong', products: 'wagyu', maxProspects: 5 },
    { targetMarkets: 'United States, Canada', seenProspects: [] }
  );

  assert.match(input, /Target markets: United States, Canada/);
  assert.doesNotMatch(input, /Target markets: Hong Kong/);
});

test('buildProspectSearchInput uses target profile saved from LINE', () => {
  const input = buildProspectSearchInput(
    { targetMarkets: 'Hong Kong', products: 'wagyu', maxProspects: 5 },
    {
      targetProfile: '日本からの輸入実績のある高級水産品の輸入会社',
      seenProspects: []
    }
  );

  assert.match(input, /Target customer profile: 日本からの輸入実績のある高級水産品の輸入会社/);
  assert.match(input, /Respect the target customer profile/);
});

test('parseProspectTargetMarketsCommand handles set show and reset commands', () => {
  assert.deepEqual(parseProspectTargetMarketsCommand('営業エリア 香港、シンガポール'), {
    action: 'set',
    targetMarkets: '香港, シンガポール'
  });
  assert.deepEqual(parseProspectTargetMarketsCommand('ターゲットエリア 確認'), {
    action: 'show',
    targetMarkets: ''
  });
  assert.deepEqual(parseProspectTargetMarketsCommand('target markets: reset'), {
    action: 'reset',
    targetMarkets: ''
  });
  assert.equal(parseProspectTargetMarketsCommand('こんにちは'), null);
});

test('parseProspectTargetProfileCommand handles set show and reset commands', () => {
  assert.deepEqual(parseProspectTargetProfileCommand('ターゲット条件 日本からの輸入実績のある高級水産品の輸入会社'), {
    action: 'set',
    targetProfile: '日本からの輸入実績のある高級水産品の輸入会社'
  });
  assert.deepEqual(parseProspectTargetProfileCommand('顧客条件 確認'), {
    action: 'show',
    targetProfile: ''
  });
  assert.deepEqual(parseProspectTargetProfileCommand('target profile: reset'), {
    action: 'reset',
    targetProfile: ''
  });
  assert.equal(parseProspectTargetProfileCommand('営業エリア 香港'), null);
});

test('parseProspectRunCommand handles natural LINE run requests', () => {
  assert.equal(parseProspectRunCommand('24時間タスク、もう一度実行'), true);
  assert.equal(parseProspectRunCommand('入力者候補を探してメール下書き作成して'), true);
  assert.equal(parseProspectRunCommand('輸入者候補を探して'), true);
  assert.equal(parseProspectRunCommand('営業候補探して'), true);
  assert.equal(parseProspectRunCommand('探して'), true);
  assert.equal(parseProspectRunCommand('prospects now'), true);
  assert.equal(parseProspectRunCommand('香港向けの牛タンについて教えて'), false);
});

test('parseProspectLineCommandClassification handles natural command JSON', () => {
  assert.deepEqual(parseProspectLineCommandClassification(JSON.stringify({
    action: 'set_profile',
    target_markets: '',
    target_profile: '日本からの輸入実績のある高級水産品の輸入会社',
    reason: 'target customer profile'
  })), {
    action: 'set_profile',
    targetMarkets: '',
    targetProfile: '日本からの輸入実績のある高級水産品の輸入会社',
    reason: 'target customer profile'
  });

  assert.deepEqual(parseProspectLineCommandClassification('not json'), {
    action: 'none',
    targetMarkets: '',
    targetProfile: '',
    reason: ''
  });
});

test('classifyProspectLineCommand asks OpenAI to route natural LINE messages', async () => {
  const command = await classifyProspectLineCommand(
    '香港で、日本からの輸入実績のある高級水産品の輸入会社を探して',
    { openaiApiKey: 'openai-key', openaiModel: 'test-model' },
    async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'test-model');
      assert.match(body.instructions, /prospect-search automation/);
      assert.match(body.input, /高級水産品/);
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            action: 'run_search',
            target_markets: '',
            target_profile: '',
            reason: 'User asks to find prospects now.'
          })
        })
      };
    }
  );

  assert.equal(command.action, 'run_search');
});

test('applyProspectTargetProfileCommand saves and resets LINE target profile', () => {
  let state = { lastRunAt: '', seenProspects: [], targetMarkets: '', targetProfile: '' };
  const config = { statePath: 'unused-state.json', targetProfile: '' };
  const options = {
    loadState: () => state,
    saveState: (_path, nextState) => {
      state = { ...nextState };
    }
  };

  const setReply = applyProspectTargetProfileCommand(
    { action: 'set', targetProfile: 'Premium seafood importers with Japan import experience' },
    config,
    options
  );
  assert.equal(state.targetProfile, 'Premium seafood importers with Japan import experience');
  assert.match(setReply, /Premium seafood importers/);
  assert.equal(getEffectiveProspectTargetProfile(config, state), 'Premium seafood importers with Japan import experience');

  const resetReply = applyProspectTargetProfileCommand({ action: 'reset', targetProfile: '' }, config, options);
  assert.equal(state.targetProfile, undefined);
  assert.match(resetReply, /\(指定なし\)/);
});

test('applyProspectTargetMarketsCommand saves and resets LINE target markets', () => {
  let state = { lastRunAt: '', seenProspects: [], targetMarkets: '' };
  const config = { statePath: 'unused-state.json', targetMarkets: 'Hong Kong' };
  const options = {
    loadState: () => state,
    saveState: (_path, nextState) => {
      state = { ...nextState };
    }
  };

  const setReply = applyProspectTargetMarketsCommand(
    { action: 'set', targetMarkets: 'United States, Canada' },
    config,
    options
  );
  assert.equal(state.targetMarkets, 'United States, Canada');
  assert.match(setReply, /United States, Canada/);
  assert.equal(getEffectiveProspectTargetMarkets(config, state), 'United States, Canada');

  const resetReply = applyProspectTargetMarketsCommand({ action: 'reset', targetMarkets: '' }, config, options);
  assert.equal(state.targetMarkets, undefined);
  assert.match(resetReply, /Hong Kong/);
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
