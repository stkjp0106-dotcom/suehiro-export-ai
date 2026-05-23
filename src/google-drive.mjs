import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
export const DRIVE_PDF_MIME_TYPE = 'application/pdf';
const PACKING_LIST_PATTERN = /(?:^|[^A-Z0-9])P\s*\/?\s*L(?:\d|[^A-Z0-9]|$)|packing\s*list|パッキングリスト/i;
const DEFAULT_TOKEN_PATH = '.tokens/google-drive.json';

export function getGoogleConfig(env = process.env) {
  const publicBaseUrl = (env.PUBLIC_BASE_URL || env.RAILWAY_PUBLIC_DOMAIN || '').replace(/\/+$/, '');
  const publicRedirectUri = publicBaseUrl
    ? `${publicBaseUrl.startsWith('http') ? publicBaseUrl : `https://${publicBaseUrl}`}/google/oauth2callback`
    : '';
  const configuredRedirectUri = env.GOOGLE_REDIRECT_URI || '';
  const redirectUri = publicRedirectUri && /^http:\/\/localhost(?::\d+)?\/google\/oauth2callback$/i.test(configuredRedirectUri)
    ? publicRedirectUri
    : configuredRedirectUri || publicRedirectUri || 'http://localhost:3000/google/oauth2callback';

  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri,
    tokenPath: env.GOOGLE_TOKEN_PATH || DEFAULT_TOKEN_PATH,
    refreshToken: env.GOOGLE_REFRESH_TOKEN
  };
}

export function hasGoogleConfig(config) {
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
}

export function isGoogleAuthExpiredError(error) {
  const message = String(error?.message || '');
  return /invalid_grant|Token has been expired or revoked|Bad Request/i.test(message);
}

export function buildGoogleAuthUrl(config, scope = DRIVE_READONLY_SCOPE) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export async function exchangeCodeForTokens(code, config, fetchImpl = fetch) {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code'
  });

  return postTokenRequest(body, fetchImpl);
}

export async function refreshAccessToken(refreshToken, config, fetchImpl = fetch) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token'
  });

  return postTokenRequest(body, fetchImpl);
}

async function postTokenRequest(body, fetchImpl) {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google token request failed: ${response.status} ${detail}`);
  }

  return response.json();
}

export function saveGoogleTokens(tokens, tokenPath = DEFAULT_TOKEN_PATH, now = Date.now()) {
  const expiresAt = tokens.expires_in ? now + tokens.expires_in * 1000 : undefined;
  const saved = {
    ...tokens,
    expires_at: expiresAt
  };

  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify(saved, null, 2), 'utf8');
  return saved;
}

export function loadGoogleTokens(tokenPath = DEFAULT_TOKEN_PATH) {
  if (!existsSync(tokenPath)) {
    return null;
  }

  return JSON.parse(readFileSync(tokenPath, 'utf8'));
}

export async function getValidAccessToken(config, fetchImpl = fetch) {
  if (config.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(config.refreshToken, config, fetchImpl);
      return refreshed.access_token;
    } catch (error) {
      if (!isGoogleAuthExpiredError(error)) {
        throw error;
      }
    }
  }

  const tokens = loadGoogleTokens(config.tokenPath);
  if (!tokens) {
    return null;
  }

  if (tokens.access_token && tokens.expires_at && tokens.expires_at > Date.now() + 60_000) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    return tokens.access_token || null;
  }

  const refreshed = await refreshAccessToken(tokens.refresh_token, config, fetchImpl);
  const merged = saveGoogleTokens(
    { ...tokens, ...refreshed, refresh_token: tokens.refresh_token },
    config.tokenPath
  );
  return merged.access_token;
}

export async function searchDriveFiles(query, accessToken, fetchImpl = fetch) {
  const terms = String(query || '')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 5);

  const nameFilters = terms.map((term) => `name contains '${escapeDriveQuery(term)}'`);
  const q = [
    'trashed = false',
    "mimeType != 'application/vnd.google-apps.folder'",
    nameFilters.length ? `(${nameFilters.join(' or ')})` : ''
  ]
    .filter(Boolean)
    .join(' and ');

  const url = new URL(DRIVE_FILES_URL);
  url.searchParams.set('q', q);
  url.searchParams.set('pageSize', '10');
  url.searchParams.set('fields', 'files(id,name,mimeType,webViewLink,modifiedTime,createdTime)');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Drive search failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  return data.files || [];
}

export async function searchDriveFolders(query, accessToken, fetchImpl = fetch) {
  const terms = getDriveSearchTerms(query);
  const nameFilters = terms.map((term) => `name contains '${escapeDriveQuery(term)}'`);
  const q = [
    'trashed = false',
    "mimeType = 'application/vnd.google-apps.folder'",
    nameFilters.length ? `(${nameFilters.join(' or ')})` : ''
  ]
    .filter(Boolean)
    .join(' and ');

  const url = new URL(DRIVE_FILES_URL);
  url.searchParams.set('q', q);
  url.searchParams.set('pageSize', '10');
  url.searchParams.set('fields', 'files(id,name,mimeType,webViewLink,modifiedTime,createdTime)');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Drive folder search failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  return data.files || [];
}

export async function listDriveFolderChildren(folderId, accessToken, fetchImpl = fetch) {
  const url = new URL(DRIVE_FILES_URL);
  url.searchParams.set('q', `'${escapeDriveQuery(folderId)}' in parents and trashed = false`);
  url.searchParams.set('pageSize', '10');
  url.searchParams.set('fields', 'files(id,name,mimeType,webViewLink,modifiedTime,createdTime)');
  url.searchParams.set('orderBy', 'folder,name');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Drive folder list failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  return data.files || [];
}

export async function downloadDriveFile(fileId, accessToken, fetchImpl = fetch) {
  const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Drive file download failed: ${response.status} ${detail}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function extractPdfText(buffer) {
  const pdfParseModule = await import('pdf-parse');
  const pdfParse = pdfParseModule.default || pdfParseModule;
  const parsed = await pdfParse(buffer);
  return parsed.text || '';
}

export function isDriveFileDetailRequest(text, context = null) {
  const value = String(text || '').trim();
  if (!value) {
    return false;
  }

  const asksForAmount = /金額|価格|値段|請求|合計|販売|売上|amount|total|price|invoice/i.test(value);
  if (asksForAmount && extractDriveReference(value)) {
    return true;
  }

  const hasRecentFiles = Array.isArray(context?.files) && context.files.length > 0;
  return hasRecentFiles && /^[A-Z]*\s*\d{2,5}\s*(?:は|って|かな)?\s*(?:？|\?)?$/i.test(value);
}

export function isDriveInvoiceLookupRequest(text, context = null) {
  const value = String(text || '').trim();
  if (!value || !Array.isArray(context?.files) || !context.files.length) {
    return false;
  }

  const mentionsInvoice = /invoice|inv[\s\-_()]*\d*|請求書|インボイス|送り状/i.test(value);
  const asksDriveLike = /直近|取引|だけ|出して|見せて|提示|どれ|どこ|ファイル|pdf|PDF|document|docs/i.test(value);
  return mentionsInvoice && (asksDriveLike || value.length <= 12);
}

export function findDriveInvoiceFiles(text, files = [], limit = 5) {
  const value = String(text || '');
  const invoiceFiles = files
    .filter((file) => /invoice|inv[\s\-_()]*\d*|請求書|インボイス/i.test(String(file.name || '')))
    .sort(compareDriveFilesByDateDesc);

  if (/直近|最新|last|recent/i.test(value)) {
    return invoiceFiles.slice(0, limit);
  }

  const reference = extractDriveReference(value);
  if (reference) {
    const byReference = invoiceFiles.filter((file) => normalizeDriveReference(file.name || '').includes(reference));
    if (byReference.length) {
      return byReference.slice(0, limit);
    }
  }

  return invoiceFiles.slice(0, limit);
}

export function summarizeDriveInvoiceFiles(files) {
  if (!files.length) {
    return '直前のDrive検索結果から、INV / Invoice / 請求書 に該当するファイルは見つかりませんでした。';
  }

  return [
    '直前のDrive検索結果から、請求書/Invoice候補を出しました。',
    '',
    ...files.map((file, index) => [
      `${index + 1}. ${file.name}`,
      file.webViewLink || ''
    ].filter(Boolean).join('\n')),
    '',
    '金額を読みたい場合は「CAN015の金額」のようにファイル番号を入れて送ってください。'
  ].join('\n');
}

export function isDriveDocumentLookupRequest(text) {
  const value = String(text || '').trim();
  if (!value) {
    return false;
  }

  const mentionsDocumentType = PACKING_LIST_PATTERN.test(value);
  const asksForFile = /前回|直近|最新|取引|出して|見せて|提示|探して|検索|ファイル|pdf|PDF|document|docs/i.test(value);
  return mentionsDocumentType && asksForFile;
}

export function buildDriveDocumentLookupQuery(text) {
  return String(text || '')
    .replace(/(?:^|[^A-Z0-9])P\s*\/?\s*L(?:\d|[^A-Z0-9]|$)|packing\s*list|パッキングリスト/gi, ' PL Packing List ')
    .replace(/前回|直近|最新|取引|出して|見せて|提示|探して|検索|ファイル|pdf|PDF|document|docs|の|を|だして|して|ください|お願い/gi, ' ')
    .replace(/[。、，,：:（）()[\]{}「」]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function filterDriveDocumentFiles(text, files = [], limit = 5) {
  const value = String(text || '');
  const wantsPackingList = PACKING_LIST_PATTERN.test(value);
  const documentPattern = wantsPackingList
    ? PACKING_LIST_PATTERN
    : /./;

  const typedFiles = files
    .filter((file) => documentPattern.test(String(file.name || '')))
    .sort(compareDriveFilesByDateDesc);

  if (typedFiles.length) {
    return typedFiles.slice(0, limit);
  }

  return [...files].sort(compareDriveFilesByDateDesc).slice(0, limit);
}

export function summarizeDriveDocumentFiles({ requestText, query, files = [] }) {
  const wantsPackingList = PACKING_LIST_PATTERN.test(requestText);
  const label = wantsPackingList ? 'PL / Packing List' : '該当書類';

  if (!files.length) {
    return `Google Driveで「${query}」に関連する${label}候補は見つかりませんでした。`;
  }

  return [
    `Google Driveで「${query}」に関連する${label}候補を出しました。`,
    '',
    ...files.map((file, index) => [
      `${index + 1}. ${file.name}`,
      file.webViewLink || ''
    ].filter(Boolean).join('\n')),
    '',
    '必要なら「1の金額」「このPDF読んで」のように続けてください。'
  ].join('\n');
}

export function extractDriveReference(text) {
  const value = String(text || '').trim();
  const prefixed = value.match(/\b([A-Z]{2,}\s*[-_]?\s*\d{2,6})\b/i);
  if (prefixed) {
    return normalizeDriveReference(prefixed[1]);
  }

  const numeric = value.match(/\b(\d{2,6})\b/);
  return numeric ? normalizeDriveReference(numeric[1]) : '';
}

export function findDriveContextFile(text, files = []) {
  const reference = extractDriveReference(text);
  if (!reference) {
    return null;
  }

  const normalizedFiles = files.map((file) => ({
    file,
    normalizedName: normalizeDriveReference(file.name || '')
  }));

  const exact = normalizedFiles.find(({ normalizedName }) => normalizedName.includes(reference));
  if (exact) {
    return exact.file;
  }

  const digits = reference.match(/\d+/)?.[0] || reference;
  const digitMatch = normalizedFiles.find(({ normalizedName }) => normalizedName.includes(digits));
  return digitMatch?.file || null;
}

export function extractAmountCandidates(text, limit = 6) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const amountPattern = /(?:USD|US\$|JPY|¥|￥|EUR|GBP|HKD|SGD|AUD|CAD|\$)\s*[-+]?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s*(?:USD|JPY|YEN|EUR|GBP|HKD|SGD|AUD|CAD)/i;
  const strongLabelPattern = /grand\s*total|invoice\s*total|total\s*amount|amount\s*due|balance\s*due|total|合計|総額|請求額|金額/i;

  const scored = [];
  for (const [index, line] of lines.entries()) {
    if (!amountPattern.test(line)) {
      continue;
    }
    const score = (strongLabelPattern.test(line) ? 10 : 0) + Math.min(index / 1000, 1);
    scored.push({ line, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .map((item) => item.line)
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, limit);
}

export function summarizeDriveFileAmount({ file, amountCandidates = [], text = '' }) {
  const lines = [
    `${file.name} を確認しました。`,
    file.webViewLink || ''
  ].filter(Boolean);

  if (amountCandidates.length) {
    lines.push('', '金額候補:');
    for (const candidate of amountCandidates) {
      lines.push(`- ${candidate}`);
    }
    lines.push('', 'PDF本文から拾った候補なので、送信前に原本で最終確認してください。');
    return lines.join('\n');
  }

  if (text.trim()) {
    lines.push('', 'PDFは読めましたが、金額らしい行を特定できませんでした。Total / Amount / 合計の表記が崩れている可能性があります。');
    return lines.join('\n');
  }

  lines.push('', 'PDF本文を読み取れませんでした。スキャン画像PDFの場合はOCR対応が必要です。');
  return lines.join('\n');
}

export function summarizeDriveFiles(files) {
  if (!files.length) {
    return 'Google Driveで該当ファイルは見つかりませんでした。';
  }

  return [
    'Google Drive search results:',
    ...files
    .map((file, index) => `${index + 1}. ${file.name} (${file.mimeType})\n${file.webViewLink}`)
  ].join('\n');
}

export function isDriveLookupRequest(text) {
  const value = String(text || '').toLowerCase();
  return (
    /drive|google\s*drive|gdrive|フォルダ|folder|ファイル|file/.test(value) ||
    /見れる|見られる|見て|確認|探して|検索/.test(value)
  ) && !/営業候補|輸入者候補|ターゲット|営業エリア/.test(String(text || ''));
}

export function buildDriveLookupQuery(text) {
  return String(text || '')
    .replace(/Google\s*Drive|GDrive|Drive/gi, ' ')
    .replace(/フォルダ|ファイル|folder|file/gi, ' ')
    .replace(/見れる|見られる|見れますか|見られますか|見て|確認|探して|検索|中身|内容|ある|ありますか|できる|できますか/gi, ' ')
    .replace(/[？?。、「」]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarizeDriveLookup({ query, folders = [], childrenByFolder = [], files = [] }) {
  if (!folders.length && !files.length) {
    return `Google Driveで「${query}」に一致するフォルダ/ファイルは見つかりませんでした。`;
  }

  const lines = [`Google Driveで「${query}」を確認しました。`];

  for (const [index, folder] of folders.entries()) {
    lines.push('', `${index + 1}. フォルダ: ${folder.name}`, folder.webViewLink || '');
    const children = childrenByFolder[index] || [];
    if (children.length) {
      lines.push('中身（一部）:');
      for (const child of children.slice(0, 5)) {
        lines.push(`- ${child.name}`);
      }
    } else {
      lines.push('中身: 表示できるファイルは見つかりませんでした。');
    }
  }

  if (files.length) {
    lines.push('', '関連ファイル:');
    for (const file of files.slice(0, 5)) {
      lines.push(`- ${file.name}`, file.webViewLink || '');
    }
  }

  return lines.filter((line) => line !== undefined).join('\n');
}

function getDriveSearchTerms(query) {
  return String(query || '')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function normalizeDriveReference(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function compareDriveFilesByDateDesc(left, right) {
  const leftTime = new Date(left.modifiedTime || left.createdTime || 0).getTime() || 0;
  const rightTime = new Date(right.modifiedTime || right.createdTime || 0).getTime() || 0;
  return rightTime - leftTime;
}

function escapeDriveQuery(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function resolveTokenPath(config, baseDir = process.cwd()) {
  if (!config.tokenPath || /^[A-Za-z]:[\\/]/.test(config.tokenPath)) {
    return config.tokenPath || join(baseDir, DEFAULT_TOKEN_PATH);
  }

  return join(baseDir, config.tokenPath);
}
