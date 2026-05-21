import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildGmailDraftHtml,
  buildGmailReplyDraftInput,
  createGmailReplyDraft as createGmailApiReplyDraft,
  getGmailAccessToken,
  getGmailMessage,
  getGmailProfile,
  listGmailHistory,
  normalizeGmailMessage
} from './gmail.mjs';

const OPENAI_RESPONSES_API_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_STATE_PATH = '.state/gmail-monitor.json';

const GMAIL_REPLY_INSTRUCTIONS = [
  'You are SUEHIRO AI, a careful email assistant for SUEHIRO TRADING.',
  'Write a reply draft for the received sales email.',
  'Do not say that the email was handled automatically.',
  'Do not invent prices, stock status, delivery dates, certifications, or legal/regulatory conclusions.',
  'If confirmation is needed, say that we will confirm internally and reply with details.',
  'Keep the tone polite, practical, and business-friendly.',
  'Reply in the language of the incoming email when possible; otherwise use Japanese.',
  'Return only the email body text, with no subject line and no markdown fences.'
].join('\n');

export function getGmailMonitorConfig(env = process.env) {
  return {
    mailbox: env.GMAIL_MAILBOX || env.OUTLOOK_MAILBOX || 'sales@suehirotrd.com',
    pollSeconds: Number(env.GMAIL_POLL_SECONDS || env.OUTLOOK_POLL_SECONDS || 60),
    statePath: env.GMAIL_STATE_PATH || join(env.DATA_DIR || '.', DEFAULT_STATE_PATH),
    processExistingOnFirstRun: env.GMAIL_PROCESS_EXISTING_ON_FIRST_RUN === 'true',
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_REDIRECT_URI || 'http://localhost:3002/google/oauth2callback',
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
      tokenPath: env.GOOGLE_TOKEN_PATH || '.tokens/google-gmail.json'
    }
  };
}

export function validateGmailMonitorConfig(config) {
  const missing = [];
  if (!config.openaiApiKey) missing.push('OPENAI_API_KEY');
  if (!config.google.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!config.google.refreshToken) missing.push('GOOGLE_REFRESH_TOKEN');
  if (!config.mailbox) missing.push('GMAIL_MAILBOX');
  return missing;
}

export async function runGmailMonitor(config, options = {}) {
  const logger = options.logger || console;
  const sleep = options.sleep || delay;
  let stopped = false;

  const stop = () => {
    stopped = true;
  };

  logger.info(`Gmail monitor starting for ${config.mailbox}`);

  while (!stopped) {
    try {
      await pollGmailMailbox(config, { logger, fetchImpl: options.fetchImpl });
    } catch (error) {
      logger.error(`Gmail monitor poll failed: ${error.stack || error.message}`);
    }

    if (!stopped) {
      await sleep(config.pollSeconds * 1000);
    }
  }

  logger.info('Gmail monitor stopped');
  return { stop };
}

export async function pollGmailMailbox(config, options = {}) {
  const logger = options.logger || console;
  const loadState = options.loadState || loadMonitorState;
  const saveState = options.saveState || saveMonitorState;
  const state = loadState(config.statePath);
  const accessToken = await getGmailAccessToken(config.google, options.fetchImpl);

  if (!state.historyId) {
    const profile = await getGmailProfile(accessToken, options.fetchImpl);
    logger.info(`Gmail baseline saved: email=${profile.emailAddress} historyId=${profile.historyId}`);
    saveState(config.statePath, { ...state, initialized: true, historyId: profile.historyId });
    return { processed: 0, baselineOnly: true, historyId: profile.historyId };
  }

  const { messages, historyId } = await listGmailHistory(state.historyId, accessToken, {
    fetchImpl: options.fetchImpl
  });

  logger.info(`Gmail poll complete: new_or_changed=${messages.length}`);

  if (!state.initialized && !config.processExistingOnFirstRun) {
    logger.info('Gmail monitor baseline saved; existing inbox messages were not processed');
    saveState(config.statePath, { ...state, initialized: true, historyId });
    return { processed: 0, baselineOnly: true, historyId };
  }

  let processed = 0;
  for (const historyMessage of messages) {
    if (state.processedMessageIds.includes(historyMessage.id)) {
      continue;
    }

    const fullMessage = await getGmailMessage(historyMessage.id, accessToken, options.fetchImpl);
    if (shouldSkipMessage(fullMessage)) {
      continue;
    }

    await processGmailMessage(fullMessage, config, accessToken, options);
    state.processedMessageIds.push(historyMessage.id);
    trimProcessedIds(state);
    processed += 1;
    saveState(config.statePath, { ...state, historyId });
  }

  saveState(config.statePath, { ...state, initialized: true, historyId });
  return { processed, historyId };
}

export async function processGmailMessage(message, config, accessToken, options = {}) {
  const logger = options.logger || console;
  const normalized = normalizeGmailMessage(message);
  logger.info(`Creating Gmail draft: messageId=${normalized.id} subject=${JSON.stringify(normalized.subject || '')}`);

  const replyText = await createGmailAiReplyDraft(normalized, {
    apiKey: config.openaiApiKey,
    model: config.openaiModel
  }, options.fetchImpl);
  const draft = await createGmailApiReplyDraft(
    normalized,
    buildGmailDraftHtml(replyText),
    accessToken,
    options.fetchImpl
  );

  logger.info(`Gmail draft saved: originalMessageId=${normalized.id} draftId=${draft.id}`);
  return { draftId: draft.id };
}

export async function createGmailAiReplyDraft(message, config, fetchImpl = fetch) {
  const response = await fetchImpl(OPENAI_RESPONSES_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      instructions: GMAIL_REPLY_INSTRUCTIONS,
      input: buildGmailReplyDraftInput(message)
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI Gmail reply draft failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  return extractOutputText(data) || '確認して返信いたします。';
}

export function loadMonitorState(path = DEFAULT_STATE_PATH) {
  if (!existsSync(path)) {
    return { initialized: false, historyId: '', processedMessageIds: [] };
  }

  const data = JSON.parse(readFileSync(path, 'utf8'));
  return {
    initialized: data.initialized === true,
    historyId: data.historyId || '',
    processedMessageIds: Array.isArray(data.processedMessageIds) ? data.processedMessageIds : []
  };
}

export function saveMonitorState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
}

function shouldSkipMessage(message) {
  const labels = message.labelIds || [];
  return labels.includes('DRAFT') || labels.includes('SENT') || labels.includes('TRASH') || labels.includes('SPAM');
}

function trimProcessedIds(state, limit = 1000) {
  if (state.processedMessageIds.length > limit) {
    state.processedMessageIds = state.processedMessageIds.slice(-limit);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
