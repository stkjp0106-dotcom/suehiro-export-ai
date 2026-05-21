import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DEFAULT_TOKEN_PATH = '.tokens/google-drive.json';

export function getGoogleConfig(env = process.env) {
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/google/oauth2callback',
    tokenPath: env.GOOGLE_TOKEN_PATH || DEFAULT_TOKEN_PATH
  };
}

export function hasGoogleConfig(config) {
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
}

export function buildGoogleAuthUrl(config) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DRIVE_READONLY_SCOPE);
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

function escapeDriveQuery(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function resolveTokenPath(config, baseDir = process.cwd()) {
  if (!config.tokenPath || /^[A-Za-z]:[\\/]/.test(config.tokenPath)) {
    return config.tokenPath || join(baseDir, DEFAULT_TOKEN_PATH);
  }

  return join(baseDir, config.tokenPath);
}
