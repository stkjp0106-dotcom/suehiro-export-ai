import { createHmac, timingSafeEqual } from 'node:crypto';

const LINE_REPLY_API_URL = 'https://api.line.me/v2/bot/message/reply';
const DEFAULT_REPLY_TEXT = '\u53d7\u4fe1\u3057\u307e\u3057\u305f\u3002\u78ba\u8a8d\u3057\u3066\u8fd4\u4fe1\u3057\u307e\u3059\u3002';

export function verifyLineSignature(body, signature, channelSecret) {
  if (!signature || !channelSecret) {
    return false;
  }

  const expected = createHmac('sha256', channelSecret).update(body).digest('base64');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function buildReceivedReply(replyToken) {
  return buildTextReply(replyToken, DEFAULT_REPLY_TEXT);
}

export function buildTextReply(replyToken, text) {
  return {
    replyToken,
    messages: [
      {
        type: 'text',
        text
      }
    ]
  };
}

export function parseLineMessageText(event) {
  if (event?.type !== 'message' || event.message?.type !== 'text') {
    return '';
  }

  return event.message.text || '';
}

export async function replyToLine(replyToken, channelAccessToken, text = DEFAULT_REPLY_TEXT, fetchImpl = fetch) {
  const response = await fetchImpl(LINE_REPLY_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildTextReply(replyToken, text))
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`LINE reply failed: ${response.status} ${detail}`);
  }
}

export async function handleLineWebhook(body, headers, config, fetchImpl = fetch) {
  const signature = headers['x-line-signature'];
  if (!verifyLineSignature(body, signature, config.channelSecret)) {
    return { status: 401, body: 'Invalid signature' };
  }

  const payload = JSON.parse(body);
  const events = Array.isArray(payload.events) ? payload.events : [];

  for (const event of events) {
    if (event.type === 'message' && event.replyToken) {
      const text = await createReplyText(event, config);
      await replyToLine(event.replyToken, config.channelAccessToken, text, fetchImpl);
    }
  }

  return { status: 200, body: 'OK' };
}

async function createReplyText(event, config) {
  if (!config.createReply) {
    return DEFAULT_REPLY_TEXT;
  }

  try {
    return await config.createReply(parseLineMessageText(event));
  } catch (error) {
    console.error(error);
    return 'OpenAI API\u306e\u5229\u7528\u67a0\u307e\u305f\u306f\u8a8d\u8a3c\u8a2d\u5b9a\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002\u8a2d\u5b9a\u304c\u5b8c\u4e86\u3057\u305f\u3089\u3001\u3082\u3046\u4e00\u5ea6\u9001\u3063\u3066\u304f\u3060\u3055\u3044\u3002';
  }
}
