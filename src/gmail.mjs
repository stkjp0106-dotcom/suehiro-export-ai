import { DRIVE_READONLY_SCOPE, getValidAccessToken } from './google-drive.mjs';

const GMAIL_BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SUEHIRO_EMAIL_SIGNATURE_LINES = [
  'ststststststststststststststststststststststststststststst',
  'Takumi Sato -佐藤 拓海-',
  'SUEHIRO TRADING Co., Ltd.',
  '',
  'Mob/Whatsapp : +81(0)9061407648',
  'Web :',
  'https://suehirotrd.com/sales/',
  '',
  '1-13-5-C63 Asakusa, Taito-ku, Tokyo, Japan. 111-0032'
];
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  DRIVE_READONLY_SCOPE
].join(' ');

export async function getGmailAccessToken(config, fetchImpl = fetch) {
  const accessToken = await getValidAccessToken(config, fetchImpl);
  if (!accessToken) {
    throw new Error('Google access token is missing. Run Gmail OAuth and set GOOGLE_REFRESH_TOKEN in Railway.');
  }

  return accessToken;
}

export async function gmailRequest(pathOrUrl, accessToken, options = {}) {
  const url = pathOrUrl.startsWith('https://')
    ? pathOrUrl
    : `${GMAIL_BASE_URL}${pathOrUrl}`;
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
    throw new Error(`Gmail API request failed: ${response.status} ${detail}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export async function getGmailProfile(accessToken, fetchImpl = fetch) {
  return gmailRequest('/profile', accessToken, { fetchImpl });
}

export async function listGmailHistory(startHistoryId, accessToken, options = {}) {
  const messages = [];
  let nextPageToken = '';
  let historyId = startHistoryId;

  do {
    const url = new URL(`${GMAIL_BASE_URL}/history`);
    url.searchParams.set('startHistoryId', startHistoryId);
    url.searchParams.set('historyTypes', 'messageAdded');
    url.searchParams.set('labelId', 'INBOX');
    if (nextPageToken) {
      url.searchParams.set('pageToken', nextPageToken);
    }

    const data = await gmailRequest(url.toString(), accessToken, {
      fetchImpl: options.fetchImpl
    });

    for (const item of data.history || []) {
      for (const added of item.messagesAdded || []) {
        if (added.message?.id) {
          messages.push(added.message);
        }
      }
    }

    nextPageToken = data.nextPageToken || '';
    historyId = data.historyId || historyId;
  } while (nextPageToken);

  return { messages: dedupeMessages(messages), historyId };
}

export async function getGmailMessage(messageId, accessToken, fetchImpl = fetch) {
  const url = new URL(`${GMAIL_BASE_URL}/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set('format', 'full');
  return gmailRequest(url.toString(), accessToken, { fetchImpl });
}

export async function createGmailReplyDraft(originalMessage, htmlBody, accessToken, fetchImpl = fetch) {
  const raw = buildReplyMime(originalMessage, htmlBody);
  return gmailRequest('/drafts', accessToken, {
    method: 'POST',
    fetchImpl,
    body: {
      message: {
        raw,
        threadId: originalMessage.threadId
      }
    }
  });
}

export async function createGmailOutboundDraft({ to, subject, htmlBody }, accessToken, fetchImpl = fetch) {
  const raw = buildOutboundMime({ to, subject }, htmlBody);
  return gmailRequest('/drafts', accessToken, {
    method: 'POST',
    fetchImpl,
    body: {
      message: {
        raw
      }
    }
  });
}

export async function findGmailLabelId(labelName, accessToken, fetchImpl = fetch) {
  const data = await gmailRequest('/labels', accessToken, { fetchImpl });
  const label = (data.labels || []).find((item) => item.name === labelName);
  return label?.id || '';
}

export async function createGmailLabel(labelName, accessToken, fetchImpl = fetch) {
  const data = await gmailRequest('/labels', accessToken, {
    method: 'POST',
    fetchImpl,
    body: {
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    }
  });
  return data.id || '';
}

export async function addGmailLabels(messageId, labelIds, accessToken, fetchImpl = fetch) {
  if (!messageId || !labelIds.length) {
    return null;
  }

  return gmailRequest(`/messages/${encodeURIComponent(messageId)}/modify`, accessToken, {
    method: 'POST',
    fetchImpl,
    body: { addLabelIds: labelIds }
  });
}

export function normalizeGmailMessage(message) {
  const headers = getHeaderMap(message.payload?.headers || []);
  return {
    id: message.id,
    threadId: message.threadId,
    historyId: message.historyId,
    subject: headers.subject || '(no subject)',
    from: headers.from || '',
    to: headers.to || '',
    cc: headers.cc || '',
    date: headers.date || '',
    messageId: headers['message-id'] || '',
    references: headers.references || '',
    inReplyTo: headers['in-reply-to'] || '',
    bodyText: extractMessageText(message.payload),
    snippet: message.snippet || '',
    labelIds: message.labelIds || []
  };
}

export function buildGmailReplyDraftInput(message) {
  return [
    'Incoming email:',
    `From: ${message.from || '(unknown)'}`,
    `Subject: ${message.subject || '(no subject)'}`,
    `Date: ${message.date || '(unknown)'}`,
    '',
    'Snippet:',
    message.snippet || '',
    '',
    'Body:',
    message.bodyText || ''
  ].join('\n');
}

export function buildGmailDraftHtml(replyText, signatureHtml = '') {
  return [
    '<p><strong>AI返信案です。送信前に必ず内容を確認してください。</strong></p>',
    '<hr>',
    textToHtml(replyText),
    '<br>',
    signatureHtml || buildSuehiroEmailSignatureHtml()
  ].join('\n');
}

export function buildSuehiroEmailSignatureHtml() {
  return textToHtml(SUEHIRO_EMAIL_SIGNATURE_LINES.join('\n'));
}

export function buildReplyMime(message, htmlBody) {
  const to = extractEmailAddress(message.from);
  const subject = /^re:/i.test(message.subject || '')
    ? message.subject
    : `Re: ${message.subject || ''}`.trim();
  const references = [message.references, message.messageId].filter(Boolean).join(' ').trim();
  const headers = [
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject || 'Re:')}`,
    ...(message.messageId ? [`In-Reply-To: ${message.messageId}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit'
  ];

  return base64UrlEncode(`${headers.join('\r\n')}\r\n\r\n${htmlBody}`);
}

export function buildOutboundMime(message, htmlBody) {
  const headers = [
    `To: ${message.to}`,
    `Subject: ${encodeMimeHeader(message.subject || '')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit'
  ];

  return base64UrlEncode(`${headers.join('\r\n')}\r\n\r\n${htmlBody}`);
}

function getHeaderMap(headers) {
  const map = {};
  for (const header of headers) {
    if (header.name) {
      map[header.name.toLowerCase()] = header.value || '';
    }
  }
  return map;
}

function extractMessageText(payload) {
  if (!payload) {
    return '';
  }

  const textParts = [];
  walkPayload(payload, (part) => {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      textParts.push(base64UrlDecode(part.body.data));
    }
  });

  if (textParts.length) {
    return textParts.join('\n\n').trim();
  }

  const htmlParts = [];
  walkPayload(payload, (part) => {
    if (part.mimeType === 'text/html' && part.body?.data) {
      htmlParts.push(stripHtml(base64UrlDecode(part.body.data)));
    }
  });

  return htmlParts.join('\n\n').trim();
}

function walkPayload(part, visit) {
  visit(part);
  for (const child of part.parts || []) {
    walkPayload(child, visit);
  }
}

function dedupeMessages(messages) {
  const seen = new Set();
  return messages.filter((message) => {
    if (seen.has(message.id)) {
      return false;
    }
    seen.add(message.id);
    return true;
  });
}

function textToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractEmailAddress(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return match ? match[1] : String(value || '').trim();
}

function encodeMimeHeader(value) {
  if (/^[\x00-\x7F]*$/.test(value)) {
    return value;
  }

  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function base64UrlEncode(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf8');
}
