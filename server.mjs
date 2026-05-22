import { createServer } from 'node:http';
import { loadDotEnv } from './src/env.mjs';
import { handleLineWebhook } from './src/line.mjs';
import { createSuehiroReply } from './src/openai.mjs';
import { loadKnowledgeContext } from './src/knowledge.mjs';
import {
  applyProspectTargetMarketsCommand,
  getProspectMonitorConfig,
  parseProspectRunCommand,
  parseProspectTargetMarketsCommand,
  runProspectSearch,
  validateProspectMonitorConfig
} from './src/prospect-monitor.mjs';
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
  getGoogleConfig,
  hasGoogleConfig,
  resolveTokenPath,
  saveGoogleTokens,
  searchDriveFiles,
  summarizeDriveFiles
} from './src/google-drive.mjs';

loadDotEnv();

const port = Number(process.env.PORT || 3000);
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  google: getGoogleConfig(process.env),
  prospect: getProspectMonitorConfig(process.env)
};
config.google.tokenPath = resolveTokenPath(config.google);

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': contentType });
  response.end(body);
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/') {
    send(response, 200, 'SUEHIRO AI LINE webhook server is running.');
    return;
  }

  if (request.method === 'GET' && request.url === '/google/auth') {
    if (!hasGoogleConfig(config.google)) {
      send(response, 500, 'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
      return;
    }

    response.writeHead(302, { Location: buildGoogleAuthUrl(config.google) });
    response.end();
    return;
  }

  if (request.method === 'GET' && request.url?.startsWith('/google/oauth2callback')) {
    if (!hasGoogleConfig(config.google)) {
      send(response, 500, 'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
      return;
    }

    try {
      const url = new URL(request.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      if (!code) {
        send(response, 400, 'Missing Google OAuth code');
        return;
      }

      const tokens = await exchangeCodeForTokens(code, config.google);
      saveGoogleTokens(tokens, config.google.tokenPath);
      send(response, 200, 'Google Drive authorization saved. You can close this tab.');
    } catch (error) {
      console.error(error);
      send(response, 500, 'Google Drive authorization failed');
    }
    return;
  }

  if (request.method !== 'POST' || request.url !== '/webhook') {
    send(response, 404, 'Not found');
    return;
  }

  if (!config.channelSecret || !config.channelAccessToken) {
    send(response, 500, 'Missing LINE_CHANNEL_SECRET or LINE_CHANNEL_ACCESS_TOKEN');
    return;
  }

  try {
    const body = await readRequestBody(request);
    const result = await handleLineWebhook(body, request.headers, {
      channelSecret: config.channelSecret,
      channelAccessToken: config.channelAccessToken,
      createReply: async (userText) => {
        const prospectTargetMarketsCommand = parseProspectTargetMarketsCommand(userText);
        if (prospectTargetMarketsCommand) {
          return applyProspectTargetMarketsCommand(prospectTargetMarketsCommand, config.prospect);
        }

        if (parseProspectRunCommand(userText)) {
          const missing = validateProspectMonitorConfig(config.prospect);
          if (missing.length) {
            return `営業候補検索を実行できません。未設定: ${missing.join(', ')}`;
          }

          runProspectSearch(config.prospect).catch((error) => {
            console.error(`LINE requested prospect search failed: ${error.stack || error.message}`);
          });
          return [
            '営業候補検索を開始しました。',
            '完了したらLINEで候補とDraft IDを報告します。',
            '自動送信はしません。'
          ].join('\n');
        }

        if (!config.openaiApiKey) {
          return 'OpenAI APIキーがまだ設定されていません。';
        }

        if (!userText) {
          return 'テキストで送ってください。';
        }

        return createSuehiroReply(userText, {
          apiKey: config.openaiApiKey,
          model: config.openaiModel,
          knowledgeContext: await buildKnowledgeContext(userText, config.google)
        });
      }
    });
    console.log(`LINE webhook handled: status=${result.status}`);
    send(response, result.status, result.body);
  } catch (error) {
    console.error(error);
    send(response, 500, 'Internal server error');
  }
});

server.listen(port, () => {
  console.log(`SUEHIRO AI LINE webhook server listening on http://localhost:${port}`);
});

async function buildKnowledgeContext(userText, googleConfig) {
  const chunks = [loadKnowledgeContext(userText)];

  if (hasGoogleConfig(googleConfig)) {
    try {
      const accessToken = await getValidAccessToken(googleConfig);
      if (accessToken) {
        const files = await searchDriveFiles(userText, accessToken);
        chunks.push(summarizeDriveFiles(files));
      } else {
        chunks.push('Google Drive API is configured but not authorized yet. Visit /google/auth on the local server.');
      }
    } catch (error) {
      console.error(error);
      chunks.push('Google Drive lookup failed. Check Google authorization and Drive API settings.');
    }
  } else {
    chunks.push('Google Drive API is not configured for this LINE bot yet.');
  }

  return chunks.filter(Boolean).join('\n\n');
}
