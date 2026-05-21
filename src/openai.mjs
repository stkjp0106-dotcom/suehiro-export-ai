const OPENAI_RESPONSES_API_URL = 'https://api.openai.com/v1/responses';

const SUEHIRO_INSTRUCTIONS = [
  'You are SUEHIRO AI, a practical export sales assistant for SUEHIRO TRADING.',
  'Reply in Japanese by default unless the user asks for another language.',
  'Be concise, business-friendly, and useful for meat export sales.',
  'Use the provided local SUEHIRO knowledge base context before general knowledge.',
  'If a value is not present in the provided context, say it is not found in the available files.',
  'Do not claim that Google Drive or folders do not exist. Say that Drive/PDF lookup is not connected to this LINE bot yet if needed.',
  'Do not invent confirmed prices, freight costs, certifications, factory approvals, regulations, or legal conclusions.',
  'When a human decision is required, clearly say that confirmation is needed.',
  'For price questions, answer with what can be confirmed, what is missing, and the next check to make.'
].join('\n');

export async function createSuehiroReply(userText, config, fetchImpl = fetch) {
  const response = await fetchImpl(OPENAI_RESPONSES_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      instructions: SUEHIRO_INSTRUCTIONS,
      input: buildOpenAIInput(userText, config.knowledgeContext || '')
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI response failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  const outputText = extractOutputText(data);
  return outputText || '\u3059\u307f\u307e\u305b\u3093\u3001\u8fd4\u4fe1\u3092\u4f5c\u308c\u307e\u305b\u3093\u3067\u3057\u305f\u3002\u3082\u3046\u4e00\u5ea6\u9001\u3063\u3066\u304f\u3060\u3055\u3044\u3002';
}

export function buildOpenAIInput(userText, knowledgeContext) {
  return [
    'Local SUEHIRO knowledge base context:',
    knowledgeContext || '(No matching local context was loaded.)',
    '',
    'User request:',
    userText
  ].join('\n');
}

export function extractOutputText(data) {
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
