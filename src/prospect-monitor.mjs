import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildGmailDraftHtml,
  createGmailOutboundDraft,
  getGmailAccessToken
} from './gmail.mjs';
import { pushLineText } from './line.mjs';

const OPENAI_RESPONSES_API_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_STATE_PATH = '.state/prospect-monitor.json';
const DEFAULT_TARGET_MARKETS = 'Hong Kong, Singapore, Vietnam, Philippines, Thailand';
const DEFAULT_PRODUCTS = 'Japanese wagyu beef, beef tongue, Japanese meat export';

const PROSPECT_DISCOVERY_INSTRUCTIONS = [
  'You are a careful export sales assistant for SUEHIRO TRADING Co., Ltd.',
  'Use web search to find potential importers, distributors, wholesalers, retailers, or food-service buyers outside Japan.',
  'Find companies that are plausible buyers for Japanese wagyu beef, beef tongue, or Japanese meat export products.',
  'Prefer companies with public evidence of importing, distributing, wholesaling, retailing, or food-service sourcing.',
  'Only include prospects where a public contact email address is visible or strongly available on an official contact page.',
  'Do not include Japanese domestic sellers, generic directories without company evidence, or companies that look unrelated.',
  'Return only compact JSON with key "prospects".',
  'Each prospect must have: company, country, website, email, contact_url, evidence, source_urls, draft_subject, draft_body.',
  'source_urls must be an array of URLs used as evidence.',
  'draft_subject must be an English email subject.',
  'draft_body must be a concise English cold outreach email body, no signature.'
].join('\n');

export function getProspectMonitorConfig(env = process.env) {
  return {
    enabled: env.PROSPECT_MONITOR_ENABLED !== 'false',
    intervalHours: Number(env.PROSPECT_INTERVAL_HOURS || 24),
    runOnStart: env.PROSPECT_RUN_ON_START !== 'false',
    maxProspects: Number(env.PROSPECT_MAX_PROSPECTS || 5),
    statePath: env.PROSPECT_STATE_PATH || join(env.DATA_DIR || '.', DEFAULT_STATE_PATH),
    targetMarkets: env.PROSPECT_TARGET_MARKETS || DEFAULT_TARGET_MARKETS,
    products: env.PROSPECT_PRODUCTS || DEFAULT_PRODUCTS,
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.PROSPECT_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini',
    lineReport: {
      to: env.LINE_REPORT_TO_ID || env.LINE_USER_ID || '',
      channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN || ''
    },
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN
    }
  };
}

export function validateProspectMonitorConfig(config) {
  const missing = [];
  if (!config.openaiApiKey) missing.push('OPENAI_API_KEY');
  if (!config.google.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!config.google.refreshToken) missing.push('GOOGLE_REFRESH_TOKEN');
  if (!config.lineReport.to) missing.push('LINE_REPORT_TO_ID');
  if (!config.lineReport.channelAccessToken) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  return missing;
}

export async function runProspectMonitor(config, options = {}) {
  const logger = options.logger || console;
  const sleep = options.sleep || delay;
  let stopped = false;

  logger.info(`Prospect monitor starting: intervalHours=${config.intervalHours} maxProspects=${config.maxProspects}`);

  while (!stopped) {
    try {
      const state = loadProspectState(config.statePath);
      if (shouldRunProspectSearch(state, config) || config.runOnStart) {
        await runProspectSearch(config, options);
        config.runOnStart = false;
      }
    } catch (error) {
      logger.error(`Prospect monitor failed: ${error.stack || error.message}`);
    }

    await sleep(config.intervalHours * 60 * 60 * 1000);
  }

  return {
    stop() {
      stopped = true;
    }
  };
}

export async function runProspectSearch(config, options = {}) {
  const logger = options.logger || console;
  const state = (options.loadState || loadProspectState)(config.statePath);
  const accessToken = await getGmailAccessToken(config.google, options.fetchImpl);
  const prospects = await discoverProspects(config, state, options.fetchImpl);
  const selected = prospects.slice(0, config.maxProspects);
  const drafts = [];

  for (const prospect of selected) {
    const draft = await createGmailOutboundDraft({
      to: prospect.email,
      subject: prospect.draftSubject,
      htmlBody: buildGmailDraftHtml(prospect.draftBody)
    }, accessToken, options.fetchImpl);
    drafts.push({ prospect, draftId: draft.id });
    state.seenProspects.push(prospect.website || prospect.email || prospect.company);
    trimSeenProspects(state);
    logger.info(`Prospect draft saved: company=${JSON.stringify(prospect.company)} draftId=${draft.id}`);
  }

  state.lastRunAt = new Date().toISOString();
  (options.saveState || saveProspectState)(config.statePath, state);
  await notifyLineAboutProspectDrafts(drafts, config, options);
  return { drafts };
}

export async function discoverProspects(config, state = {}, fetchImpl = fetch) {
  const response = await fetchImpl(OPENAI_RESPONSES_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.openaiModel,
      tools: [{ type: 'web_search_preview' }],
      tool_choice: 'auto',
      instructions: PROSPECT_DISCOVERY_INSTRUCTIONS,
      input: buildProspectSearchInput(config, state)
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI prospect discovery failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  return parseProspects(extractOutputText(data));
}

export function buildProspectSearchInput(config, state = {}) {
  return [
    `Target markets: ${config.targetMarkets}`,
    `Target products: ${config.products}`,
    `Find up to ${config.maxProspects} new prospects.`,
    '',
    'Already used prospects to avoid:',
    ...(state.seenProspects || []).slice(-100).map((item) => `- ${item}`)
  ].join('\n');
}

export async function notifyLineAboutProspectDrafts(drafts, config, options = {}) {
  const logger = options.logger || console;
  if (!drafts.length) {
    await pushLineText(
      config.lineReport.to,
      config.lineReport.channelAccessToken,
      '24時間営業タスク: 今回は条件に合う新規輸入者候補が見つかりませんでした。',
      options.fetchImpl
    );
    return false;
  }

  const text = buildProspectLineReport(drafts);
  await pushLineText(config.lineReport.to, config.lineReport.channelAccessToken, text, options.fetchImpl);
  logger.info(`Prospect LINE report sent: drafts=${drafts.length}`);
  return true;
}

export function buildProspectLineReport(drafts) {
  return [
    '24時間営業タスク: 輸入者候補を見つけて営業メール下書きを作成しました。',
    '',
    ...drafts.map(({ prospect, draftId }, index) => [
      `${index + 1}. ${prospect.company} (${prospect.country})`,
      `Email: ${prospect.email}`,
      `Web: ${prospect.website}`,
      `理由: ${prospect.evidence}`,
      `Draft ID: ${draftId}`
    ].join('\n')),
    '',
    '自動送信はしていません。内容を確認してから送信してください。'
  ].join('\n\n');
}

export function parseProspects(text) {
  const data = JSON.parse(stripJsonCodeFence(text));
  const prospects = Array.isArray(data.prospects) ? data.prospects : [];
  return prospects.map(normalizeProspect).filter((prospect) => prospect.company && prospect.email);
}

export function loadProspectState(path = DEFAULT_STATE_PATH) {
  if (!existsSync(path)) {
    return { lastRunAt: '', seenProspects: [] };
  }

  const data = JSON.parse(readFileSync(path, 'utf8'));
  return {
    lastRunAt: data.lastRunAt || '',
    seenProspects: Array.isArray(data.seenProspects) ? data.seenProspects : []
  };
}

export function saveProspectState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
}

function shouldRunProspectSearch(state, config) {
  if (!state.lastRunAt) {
    return true;
  }

  const elapsedMs = Date.now() - new Date(state.lastRunAt).getTime();
  return elapsedMs >= config.intervalHours * 60 * 60 * 1000;
}

function normalizeProspect(item) {
  return {
    company: String(item.company || '').trim(),
    country: String(item.country || '').trim(),
    website: String(item.website || '').trim(),
    email: String(item.email || '').trim(),
    contactUrl: String(item.contact_url || '').trim(),
    evidence: String(item.evidence || '').trim(),
    sourceUrls: Array.isArray(item.source_urls) ? item.source_urls.map(String) : [],
    draftSubject: String(item.draft_subject || '').trim() || 'Japanese wagyu export inquiry',
    draftBody: String(item.draft_body || '').trim()
  };
}

function trimSeenProspects(state, limit = 500) {
  if (state.seenProspects.length > limit) {
    state.seenProspects = state.seenProspects.slice(-limit);
  }
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string') {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  return parts.join('\n').trim();
}

function stripJsonCodeFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
