import { createServer } from 'node:http';
import { loadDotEnv } from './src/env.mjs';
import {
  buildDelegatedAuthUrl,
  exchangeDelegatedCodeForTokens,
  getGraphConfig
} from './src/graph.mjs';

loadDotEnv();

const port = Number(process.env.AUTH_PORT || 3001);
const redirectUri = process.env.MICROSOFT_REDIRECT_URI || `http://localhost:${port}/callback`;
const config = getGraphConfig(process.env);

if (!config.clientId || !config.clientSecret) {
  console.error('Missing MICROSOFT_CLIENT_ID or MICROSOFT_CLIENT_SECRET');
  process.exit(1);
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(302, {
      Location: buildDelegatedAuthUrl(config, redirectUri)
    });
    response.end();
    return;
  }

  if (request.method === 'GET' && request.url?.startsWith('/callback')) {
    try {
      const url = new URL(request.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      if (!code) {
        send(response, 400, 'Missing code');
        return;
      }

      const tokens = await exchangeDelegatedCodeForTokens(config, code, redirectUri);
      console.log('Set this Railway variable:');
      console.log(`MICROSOFT_REFRESH_TOKEN=${tokens.refresh_token}`);
      send(response, 200, 'Authorization complete. Copy MICROSOFT_REFRESH_TOKEN from the terminal/Railway log.');
    } catch (error) {
      console.error(error);
      send(response, 500, 'Authorization failed. Check terminal logs.');
    }
    return;
  }

  send(response, 404, 'Not found');
});

server.listen(port, () => {
  console.log(`Open http://localhost:${port}/ to authorize Outlook delegated access.`);
  console.log(`Redirect URI: ${redirectUri}`);
});

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}
