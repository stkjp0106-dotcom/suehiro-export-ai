import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createReplyDraft,
  fetchMessageDelta,
  getGraphAccessToken,
  updateDraftBody
} from './graph.mjs';
import { buildDraftHtml, createOutlookReplyDraft } from './outlook-ai.mjs';

const DEFAULT_STATE_PATH = '.state/outlook-monitor.json';

export function getOutlookMonitorConfig(env = process.env) {
  return {
    mailbox: env.OUTLOOK_MAILBOX || 'sales@suehirotrd.com',
    pollSeconds: Number(env.OUTLOOK_POLL_SECONDS || 60),
    statePath: env.OUTLOOK_STATE_PATH || join(env.DATA_DIR || '.', DEFAULT_STATE_PATH),
    processExistingOnFirstRun: env.OUTLOOK_PROCESS_EXISTING_ON_FIRST_RUN === 'true',
    openaiApiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
    graph: {
      tenantId: env.MICROSOFT_TENANT_ID,
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      refreshToken: env.MICROSOFT_REFRESH_TOKEN,
      mailbox: env.MICROSOFT_REFRESH_TOKEN ? 'me' : (env.OUTLOOK_MAILBOX || 'sales@suehirotrd.com')
    }
  };
}

export function validateOutlookMonitorConfig(config) {
  const missing = [];
  if (!config.openaiApiKey) missing.push('OPENAI_API_KEY');
  if (!config.graph.clientId) missing.push('MICROSOFT_CLIENT_ID');
  if (!config.graph.clientSecret) missing.push('MICROSOFT_CLIENT_SECRET');
  if (!config.graph.refreshToken && !config.graph.tenantId) missing.push('MICROSOFT_TENANT_ID');
  if (!config.mailbox) missing.push('OUTLOOK_MAILBOX');
  return missing;
}

export async function runOutlookMonitor(config, options = {}) {
  const logger = options.logger || console;
  const sleep = options.sleep || delay;
  let stopped = false;

  const stop = () => {
    stopped = true;
  };

  logger.info(`Outlook monitor starting for ${config.mailbox}`);

  while (!stopped) {
    try {
      await pollOutlookMailbox(config, { logger, fetchImpl: options.fetchImpl });
    } catch (error) {
      logger.error(`Outlook monitor poll failed: ${error.stack || error.message}`);
    }

    if (!stopped) {
      await sleep(config.pollSeconds * 1000);
    }
  }

  logger.info('Outlook monitor stopped');
  return { stop };
}

export async function pollOutlookMailbox(config, options = {}) {
  const logger = options.logger || console;
  const loadState = options.loadState || loadMonitorState;
  const saveState = options.saveState || saveMonitorState;
  const state = loadState(config.statePath);
  const accessToken = await getGraphAccessToken(config.graph, options.fetchImpl);
  const { messages, deltaLink } = await fetchMessageDelta(
    config.mailbox,
    accessToken,
    state,
    { fetchImpl: options.fetchImpl }
  );

  logger.info(`Outlook poll complete: new_or_changed=${messages.length}`);

  if (!state.initialized && !config.processExistingOnFirstRun) {
    logger.info('Outlook monitor baseline saved; existing inbox messages were not processed');
    saveState(config.statePath, { ...state, initialized: true, deltaLink });
    return { processed: 0, deltaLink, baselineOnly: true };
  }

  for (const message of messages) {
    if (state.processedMessageIds.includes(message.id)) {
      continue;
    }

    await processIncomingMessage(message, config, accessToken, options);
    state.processedMessageIds.push(message.id);
    trimProcessedIds(state);
    saveState(config.statePath, { ...state, deltaLink });
  }

  saveState(config.statePath, { ...state, initialized: true, deltaLink });
  return { processed: messages.length, deltaLink };
}

export async function processIncomingMessage(message, config, accessToken, options = {}) {
  const logger = options.logger || console;
  logger.info(`Creating Outlook draft: messageId=${message.id} subject=${JSON.stringify(message.subject || '')}`);

  const replyText = await createOutlookReplyDraft(message, {
    apiKey: config.openaiApiKey,
    model: config.openaiModel
  }, options.fetchImpl);
  const draft = await createReplyDraft(config.mailbox, message.id, accessToken, options.fetchImpl);
  await updateDraftBody(config.mailbox, draft.id, buildDraftHtml(replyText), accessToken, options.fetchImpl);

  logger.info(`Outlook draft saved: originalMessageId=${message.id} draftMessageId=${draft.id}`);
  return { draftId: draft.id };
}

export function loadMonitorState(path = DEFAULT_STATE_PATH) {
  if (!existsSync(path)) {
    return { initialized: false, deltaLink: '', processedMessageIds: [] };
  }

  const data = JSON.parse(readFileSync(path, 'utf8'));
  return {
    initialized: data.initialized === true,
    deltaLink: data.deltaLink || '',
    processedMessageIds: Array.isArray(data.processedMessageIds) ? data.processedMessageIds : []
  };
}

export function saveMonitorState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
}

function trimProcessedIds(state, limit = 1000) {
  if (state.processedMessageIds.length > limit) {
    state.processedMessageIds = state.processedMessageIds.slice(-limit);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
