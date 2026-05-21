const OPENAI_RESPONSES_API_URL = 'https://api.openai.com/v1/responses';

const OUTLOOK_REPLY_INSTRUCTIONS = [
  'You are SUEHIRO AI, a careful email assistant for SUEHIRO TRADING.',
  'Write a reply draft for the received sales email.',
  'Do not say that the email was handled automatically.',
  'Do not invent prices, stock status, delivery dates, certifications, or legal/regulatory conclusions.',
  'If confirmation is needed, say that we will confirm internally and reply with details.',
  'Keep the tone polite, practical, and business-friendly.',
  'Reply in the language of the incoming email when possible; otherwise use Japanese.',
  'Return only the email body text, with no subject line and no markdown fences.'
].join('\n');

export function buildReplyDraftInput(message) {
  return [
    'Incoming email:',
    `From: ${formatEmailAddress(message.from?.emailAddress)}`,
    `Subject: ${message.subject || '(no subject)'}`,
    `Received: ${message.receivedDateTime || '(unknown)'}`,
    '',
    'Body preview:',
    message.bodyPreview || '',
    '',
    'Body:',
    message.body?.content || ''
  ].join('\n');
}

export async function createOutlookReplyDraft(message, config, fetchImpl = fetch) {
  const response = await fetchImpl(OPENAI_RESPONSES_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      instructions: OUTLOOK_REPLY_INSTRUCTIONS,
      input: buildReplyDraftInput(message)
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI reply draft failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  return extractOutputText(data) || '確認して返信いたします。';
}

export function buildDraftHtml(replyText) {
  return [
    '<p><strong>AI返信案です。送信前に必ず内容を確認してください。</strong></p>',
    '<hr>',
    textToHtml(replyText)
  ].join('\n');
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

function formatEmailAddress(emailAddress) {
  if (!emailAddress) {
    return '(unknown)';
  }

  return [emailAddress.name, emailAddress.address].filter(Boolean).join(' <') +
    (emailAddress.name && emailAddress.address ? '>' : '');
}
