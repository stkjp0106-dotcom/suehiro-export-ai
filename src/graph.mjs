const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const MICROSOFT_TOKEN_SCOPE = 'https://graph.microsoft.com/.default';

export function getGraphConfig(env = process.env) {
  return {
    tenantId: env.MICROSOFT_TENANT_ID,
    clientId: env.MICROSOFT_CLIENT_ID,
    clientSecret: env.MICROSOFT_CLIENT_SECRET,
    mailbox: env.OUTLOOK_MAILBOX || 'sales@suehirotrd.com'
  };
}

export function validateGraphConfig(config) {
  return ['tenantId', 'clientId', 'clientSecret', 'mailbox'].filter((key) => !config[key]);
}

export async function getGraphAccessToken(config, fetchImpl = fetch) {
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
    throw new Error(`Microsoft Graph request failed: ${response.status} ${detail}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
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

export async function fetchMessageDelta(mailbox, accessToken, state, options = {}) {
  const startUrl = state.deltaLink || buildInboxDeltaUrl(mailbox);
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
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(originalMessageId)}/createReply`,
    accessToken,
    { method: 'POST', fetchImpl }
  );
}

export async function updateDraftBody(mailbox, draftMessageId, htmlBody, accessToken, fetchImpl = fetch) {
  return graphRequest(
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(draftMessageId)}`,
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
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(draftMessageId)}/send`,
    accessToken,
    { method: 'POST', fetchImpl }
  );
}
