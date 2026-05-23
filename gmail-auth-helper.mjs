import { createServer } from 'node:http';
import { loadDotEnv } from './src/env.mjs';
import { getGoogleConfig, buildGoogleAuthUrl, exchangeCodeForTokens } from './src/google-drive.mjs';
import { GMAIL_SCOPES } from './src/gmail.mjs';

loadDotEnv('.env.txt');
loadDotEnv();

const DEFAULT_AUTH_PORT = Number(process.env.AUTH_PORT || 3002);

const config = {
  ...getGoogleConfig(process.env),
  redirectUri: process.env.AUTH_PORT
    ? `http://localhost:${DEFAULT_AUTH_PORT}/google/oauth2callback`
    : process.env.GOOGLE_REDIRECT_URI || `http://localhost:${DEFAULT_AUTH_PORT}/google/oauth2callback`
};
const AUTH_PORT = Number(new URL(config.redirectUri).port || DEFAULT_AUTH_PORT);

if (!config.clientId || !config.clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${AUTH_PORT}`);

  if (url.pathname === '/') {
    const authUrl = buildGoogleAuthUrl(config, GMAIL_SCOPES);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<a href="${authUrl}">Authorize Gmail + Drive access</a>`);
    return;
  }

  if (url.pathname === '/google/oauth2callback') {
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Missing code');
      return;
    }

    try {
      const tokens = await exchangeCodeForTokens(code, config);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end([
        'Gmail + Drive OAuth completed.',
        'Copy this value to Railway Variables:',
        '',
        `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token || '(no refresh_token returned; revoke app access and retry)'}`
      ].join('\n'));
      console.info('GOOGLE_REFRESH_TOKEN:');
      console.info(tokens.refresh_token || '(no refresh_token returned; revoke app access and retry)');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.stack || error.message);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(AUTH_PORT, () => {
  console.info(`Open http://localhost:${AUTH_PORT}/ and sign in as the Gmail account behind sales@suehirotrd.com.`);
});
