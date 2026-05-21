const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const MICROSOFT_TOKEN_SCOPE = 'https://graph.microsoft.com/.default';
const MICROSOFT_DELEGATED_SCOPES = 'offline_access Mail.ReadWrite';

export function getGraphConfig(env = process.env) {
  return {
    tenantId: env.MICROSOFT_TENANT_ID,
    clientId: env.MICROSOFT_CLIENT_ID,
    clientSecret: env.MICROSOFT_CLIENT_SECRET,
    refreshToken: env.MICROSOFT_REFRESH_TOKEN,
    mailbox: env.OUTLOOK_MAILBOX || 'sales@suehirotrd.com'
  };
}

export function validateGraphConfig(config) {
  const missing = ['tenantId', 'clientId', 'clientSecret', 'mailbox'].filter((key) => !config[key]);
  if (!config.refreshToken) {
    return missing;
  }

  return missing.filter((key) => key !== 'tenantId');
}

export async function getGraphAccessToken(config, fetchImpl = fetch) {
  if (config.refreshToken) {
    return getDelegatedGraphAccessToken(config, fetchImpl);
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: MICROSOFT_TOKEN_SCOPE,
    grant_type: 'client_credentials'
  });

  const response = await fetchImpl(
    `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Microsoft token request failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  return data.access_token;
}

export function buildDelegatedAuthUrl(config, redirectUri, state = 'outlook-monitor') {
  const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId || 'common')}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', MICROSOFT_DELEGATED_SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeDelegatedCodeForTokens(config, code, redirectUri, fetchImpl = fetch) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    scope: MICROSOFT_DELEGATED_SCOPES
  });

  return postMicrosoftTokenRequest(config.tenantId || 'common', body, fetchImpl);
}

export async function refreshDelegatedTokens(config, fetchImpl = fetch) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
    scope: MICROSOFT_DELEGATED_SCOPES
  });

  return postMicrosoftTokenRequest(config.tenantId || 'common', body, fetchImpl);
}

export async function getDelegatedGraphAccessToken(config, fetchImpl = fetch) {
  const data = await refreshDelegatedTokens(config, fetchImpl);
  return data.access_token;
}

async function postMicrosoftTokenRequest(tenantId, body, fetchImpl) {
  const response = await fetchImpl(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Microsoft delegated token request failed: ${response.status} ${detail}`);
  }

  return response.json();
}

export async function graphRequest(pathOrUrl, accessToken, options = {}) {
  const url = pathOrUrl.startsWith('https://')
    ? pathOrUrl
    : `${GRAPH_BASE_URL}${pathOrUrl}`;
  const response = await (options.fetchImpl || fetch)(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(formatGraphError(response.status, detail));
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function formatGraphError(status, detail) {
  const suffix = detail ? ` ${detail}` : '';
  if (status === 401) {
    return [
      `Microsoft Graph request failed: ${status}${suffix}`,
      'Check that OUTLOOK_MAILBOX is an Exchange Online mailbox in this tenant,',
      'that the app has admin consent for Mail.ReadWrite application permission,',
      'and that the mailbox has an Exchange Online-capable license.'
    ].join(' ');
  }

  return `Microsoft Graph request failed: ${status}${suffix}`;
}

export function buildInboxDeltaUrl(mailbox) {
  const select = [
    'id',
    'subject',
    'from',
    'sender',
    'replyTo',
    'toRecipients',
    'ccRecipients',
    'receivedDateTime',
    'bodyPreview',
    'body',
    'conversationId',
    'internetMessageId',
    'isDraft'
  ].join(',');

  return `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages/delta?changeType=created&$select=${select}`;
}

export function buildMyInboxDeltaUrl() {
  return buildInboxDeltaUrl('me').replace('/users/me/', '/me/');
}

export async function fetchMessageDelta(mailbox, accessToken, state, options = {}) {
  const startUrl = state.deltaLink || (mailbox === 'me' ? buildMyInboxDeltaUrl() : buildInboxDeltaUrl(mailbox));
  const messages = [];
  let nextUrl = startUrl;
  let deltaLink = state.deltaLink || '';

  while (nextUrl) {
    const data = await graphRequest(nextUrl, accessToken, {
      fetchImpl: options.fetchImpl,
      headers: { Prefer: `odata.maxpagesize=${options.pageSize || 25}` }
    });

    for (const message of data.value || []) {
      if (!message['@removed'] && message.id && !message.isDraft) {
        messages.push(message);
      }
    }

    nextUrl = data['@odata.nextLink'] || '';
    deltaLink = data['@odata.deltaLink'] || deltaLink;
  }

  return { messages, deltaLink };
}

export async function createReplyDraft(mailbox, originalMessageId, accessToken, fetchImpl = fetch) {
  return graphRequest(
    buildMessagePath(mailbox, originalMessageId, 'createReply'),
    accessToken,
    { method: 'POST', fetchImpl }
  );
}

export async function updateDraftBody(mailbox, draftMessageId, htmlBody, accessToken, fetchImpl = fetch) {
  return graphRequest(
    buildMessagePath(mailbox, draftMessageId),
    accessToken,
    {
      method: 'PATCH',
      fetchImpl,
      body: {
        body: {
          contentType: 'HTML',
          content: htmlBody
        }
      }
    }
  );
}

export async function sendDraft(mailbox, draftMessageId, accessToken, fetchImpl = fetch) {
  return graphRequest(
    buildMessagePath(mailbox, draftMessageId, 'send'),
    accessToken,
    { method: 'POST', fetchImpl }
  );
}

function buildMessagePath(mailbox, messageId, action = '') {
  const prefix = mailbox === 'me'
    ? '/me'
    : `/users/${encodeURIComponent(mailbox)}`;
  return `${prefix}/messages/${encodeURIComponent(messageId)}${action ? `/${action}` : ''}`;
}
