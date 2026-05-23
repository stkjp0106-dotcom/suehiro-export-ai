import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadDotEnv } from './src/env.mjs';
import { handleLineWebhook } from './src/line.mjs';
import { createSuehiroReply } from './src/openai.mjs';
import { loadKnowledgeContext } from './src/knowledge.mjs';
import {
  applyProspectTargetProfileCommand,
  applyProspectTargetMarketsCommand,
  classifyProspectLineCommand,
  getProspectMonitorConfig,
  parseProspectRunCommand,
  parseProspectSendDraftCommand,
  parseProspectTargetProfileCommand,
  parseProspectTargetMarketsCommand,
  runProspectSearch,
  sendProspectDraftsFromLine,
  validateProspectMonitorConfig
} from './src/prospect-monitor.mjs';
import {
  buildGoogleAuthUrl,
  buildDriveDocumentLookupQuery,
  downloadDriveFile,
  DRIVE_FOLDER_MIME_TYPE,
  extractAmountCandidates,
  buildDriveLookupQuery,
  exchangeCodeForTokens,
  extractDriveReference,
  extractPdfText,
  findDriveInvoiceFiles,
  findDriveContextFile,
  getValidAccessToken,
  getGoogleConfig,
  hasGoogleConfig,
  filterDriveDocumentFiles,
  isDriveFileDetailRequest,
  isDriveDocumentLookupRequest,
  isDriveInvoiceLookupRequest,
  isDriveLookupRequest,
  listDriveFolderChildren,
  resolveTokenPath,
  saveGoogleTokens,
  searchDriveFolders,
  searchDriveFiles,
  summarizeDriveDocumentFiles,
  summarizeDriveFileAmount,
  summarizeDriveInvoiceFiles,
  summarizeDriveLookup,
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
  prospect: getProspectMonitorConfig(process.env),
  lineDriveContextPath: process.env.LINE_DRIVE_CONTEXT_PATH || join(process.env.DATA_DIR || '.', '.state/line-drive-context.json')
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

        const prospectTargetProfileCommand = parseProspectTargetProfileCommand(userText);
        if (prospectTargetProfileCommand) {
          return applyProspectTargetProfileCommand(prospectTargetProfileCommand, config.prospect);
        }

        if (parseProspectRunCommand(userText)) {
          return startProspectSearchFromLine(config.prospect);
        }

        const prospectSendDraftCommand = parseProspectSendDraftCommand(userText);
        if (prospectSendDraftCommand) {
          return sendProspectDraftsFromLine(prospectSendDraftCommand, config.prospect);
        }

        if (config.openaiApiKey) {
          try {
            const naturalCommand = await classifyProspectLineCommand(userText, config.prospect);
            const naturalReply = handleNaturalProspectLineCommand(naturalCommand, config.prospect);
            if (naturalReply) {
              return naturalReply;
            }
          } catch (error) {
            console.error(`Prospect LINE command classification failed: ${error.stack || error.message}`);
          }
        }

        if (!config.openaiApiKey) {
          return 'OpenAI APIキーがまだ設定されていません。';
        }

        if (!userText) {
          return 'テキストで送ってください。';
        }

        const lineDriveContext = loadLineDriveContext(config.lineDriveContextPath);
        if (isDriveFileDetailRequest(userText, lineDriveContext)) {
          return answerDriveFileDetail(userText, config.google, lineDriveContext);
        }

        if (isDriveInvoiceLookupRequest(userText, lineDriveContext)) {
          return summarizeDriveInvoiceFiles(findDriveInvoiceFiles(userText, lineDriveContext.files || []));
        }

        if (isDriveDocumentLookupRequest(userText)) {
          return answerDriveDocumentLookup(userText, config.google, config.lineDriveContextPath);
        }

        if (isDriveLookupRequest(userText)) {
          return answerDriveLookup(userText, config.google, config.lineDriveContextPath);
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

async function answerDriveLookup(userText, googleConfig, contextPath) {
  if (!hasGoogleConfig(googleConfig)) {
    return 'Google Drive検索の設定が未完了です。GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI を確認してください。';
  }

  const query = buildDriveLookupQuery(userText);
  if (!query) {
    return '確認したいGoogle Driveのフォルダ名かファイル名をもう少し具体的に送ってください。';
  }

  try {
    const accessToken = await getValidAccessToken(googleConfig);
    if (!accessToken) {
      return 'Google Driveの認可がまだ完了していません。/google/auth で認可してください。';
    }

    const folders = await searchDriveFolders(query, accessToken);
    const selectedFolders = folders.slice(0, 3);
    const childrenByFolder = [];
    for (const folder of selectedFolders) {
      childrenByFolder.push(await listDriveFolderChildren(folder.id, accessToken));
    }
    const files = folders.length ? [] : await searchDriveFiles(query, accessToken);
    saveLineDriveContext(contextPath, buildLineDriveContext(query, selectedFolders, childrenByFolder, files));
    return summarizeDriveLookup({
      query,
      folders: selectedFolders,
      childrenByFolder,
      files
    });
  } catch (error) {
    console.error(error);
    if (isGoogleDriveScopeError(error)) {
      return [
        'Google Driveを見る権限が今のGoogle認可トークンに入っていません。',
        'Gmail用に認可したトークンを、Drive閲覧権限つきで作り直す必要があります。',
        'こちらで再認可URLを開くので、認可後に新しい GOOGLE_REFRESH_TOKEN をRailwayへ入れ直してください。'
      ].join('\n');
    }
    return `Google Drive検索でエラーが出ました: ${error.message}`;
  }
}

async function answerDriveDocumentLookup(userText, googleConfig, contextPath) {
  if (!hasGoogleConfig(googleConfig)) {
    return 'Google Drive検索の設定が未完了です。GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI を確認してください。';
  }

  const query = buildDriveDocumentLookupQuery(userText);
  if (!query) {
    return '探したい書類名か会社名をもう少し具体的に送ってください。';
  }

  try {
    const accessToken = await getValidAccessToken(googleConfig);
    if (!accessToken) {
      return 'Google Driveの認可がまだ完了していません。/google/auth で認可してください。';
    }

    const files = await searchDriveFiles(query, accessToken);
    const selectedFiles = filterDriveDocumentFiles(userText, files);
    saveLineDriveContext(contextPath, buildLineDriveContext(query, [], [], selectedFiles.length ? selectedFiles : files));
    return summarizeDriveDocumentFiles({
      requestText: userText,
      query,
      files: selectedFiles
    });
  } catch (error) {
    console.error(error);
    if (isGoogleDriveScopeError(error)) {
      return 'Google Driveを見る権限が今のGoogle認可トークンに入っていません。Drive閲覧権限つきで再認可してください。';
    }
    return `Google Drive書類検索でエラーが出ました: ${error.message}`;
  }
}

async function answerDriveFileDetail(userText, googleConfig, context) {
  if (!hasGoogleConfig(googleConfig)) {
    return 'Google Drive検索の設定が未完了です。GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI を確認してください。';
  }

  try {
    const accessToken = await getValidAccessToken(googleConfig);
    if (!accessToken) {
      return 'Google Driveの認可がまだ完了していません。/google/auth で認可してください。';
    }

    let file = findDriveContextFile(userText, context?.files || []);
    if (!file) {
      const reference = extractDriveReference(userText);
      const files = reference ? await searchDriveFiles(reference, accessToken) : [];
      file = findDriveContextFile(userText, files) || files.find((candidate) => candidate.mimeType === 'application/pdf') || files[0];
    }

    if (!file) {
      return '該当するDriveファイルを見つけられませんでした。直前にフォルダ名を送ってから、CAN015の金額 のように聞いてください。';
    }

    if (file.mimeType !== 'application/pdf') {
      return `${file.name} はPDFではないため、今の読み取り対象外です。\n${file.webViewLink || ''}`.trim();
    }

    const buffer = await downloadDriveFile(file.id, accessToken);
    const text = await extractPdfText(buffer);
    const amountCandidates = extractAmountCandidates(text);
    return summarizeDriveFileAmount({ file, amountCandidates, text });
  } catch (error) {
    console.error(error);
    if (isGoogleDriveScopeError(error)) {
      return 'Google Driveを見る権限が今のGoogle認可トークンに入っていません。Drive閲覧権限つきで再認可してください。';
    }
    return `DriveのPDF確認でエラーが出ました: ${error.message}`;
  }
}

function buildLineDriveContext(query, folders, childrenByFolder, files) {
  const childFiles = childrenByFolder.flatMap((children, folderIndex) => {
    const folder = folders[folderIndex];
    return (children || []).map((child) => ({
      ...child,
      parentFolderId: folder?.id,
      parentFolderName: folder?.name
    }));
  });

  return {
    query,
    updatedAt: new Date().toISOString(),
    folders,
    files: [...childFiles, ...files]
      .filter((file) => file && file.mimeType !== DRIVE_FOLDER_MIME_TYPE)
      .slice(0, 100)
  };
}

function loadLineDriveContext(contextPath) {
  try {
    if (!contextPath || !existsSync(contextPath)) {
      return null;
    }
    return JSON.parse(readFileSync(contextPath, 'utf8'));
  } catch (error) {
    console.error(`LINE Drive context load failed: ${error.message}`);
    return null;
  }
}

function saveLineDriveContext(contextPath, context) {
  try {
    if (!contextPath) {
      return;
    }
    mkdirSync(dirname(contextPath), { recursive: true });
    writeFileSync(contextPath, JSON.stringify(context, null, 2), 'utf8');
  } catch (error) {
    console.error(`LINE Drive context save failed: ${error.message}`);
  }
}

function isGoogleDriveScopeError(error) {
  const message = String(error?.message || '');
  return /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions/i.test(message);
}

function handleNaturalProspectLineCommand(command, prospectConfig) {
  if (!command || command.action === 'none') {
    return '';
  }

  if (command.action === 'set_markets') {
    return applyProspectTargetMarketsCommand(
      { action: 'set', targetMarkets: command.targetMarkets },
      prospectConfig
    );
  }
  if (command.action === 'show_markets') {
    return applyProspectTargetMarketsCommand({ action: 'show', targetMarkets: '' }, prospectConfig);
  }
  if (command.action === 'reset_markets') {
    return applyProspectTargetMarketsCommand({ action: 'reset', targetMarkets: '' }, prospectConfig);
  }
  if (command.action === 'set_profile') {
    return applyProspectTargetProfileCommand(
      { action: 'set', targetProfile: command.targetProfile },
      prospectConfig
    );
  }
  if (command.action === 'show_profile') {
    return applyProspectTargetProfileCommand({ action: 'show', targetProfile: '' }, prospectConfig);
  }
  if (command.action === 'reset_profile') {
    return applyProspectTargetProfileCommand({ action: 'reset', targetProfile: '' }, prospectConfig);
  }
  if (command.action === 'run_search') {
    return startProspectSearchFromLine(prospectConfig);
  }

  return '';
}

function startProspectSearchFromLine(prospectConfig) {
  const missing = validateProspectMonitorConfig(prospectConfig);
  if (missing.length) {
    return `営業候補検索を実行できません。未設定: ${missing.join(', ')}`;
  }

  runProspectSearch(prospectConfig).catch((error) => {
    console.error(`LINE requested prospect search failed: ${error.stack || error.message}`);
  });
  return [
    '営業候補検索を開始しました。',
    '完了したらLINEで候補とDraft IDを報告します。',
    '自動送信はしません。'
  ].join('\n');
}
