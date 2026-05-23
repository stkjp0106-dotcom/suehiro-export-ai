import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDriveLookupQuery,
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  isDriveLookupRequest,
  listDriveFolderChildren,
  refreshAccessToken,
  searchDriveFolders,
  searchDriveFiles,
  summarizeDriveLookup,
  summarizeDriveFiles
} from '../src/google-drive.mjs';

test('buildGoogleAuthUrl creates a Drive readonly consent URL', () => {
  const url = new URL(
    buildGoogleAuthUrl({
      clientId: 'client-id',
      redirectUri: 'http://localhost:3000/google/oauth2callback'
    })
  );

  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/google/oauth2callback');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.match(url.searchParams.get('scope'), /drive\.readonly/);
});

test('exchangeCodeForTokens posts to Google token endpoint', async () => {
  const calls = [];

  const tokens = await exchangeCodeForTokens(
    'code-123',
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://localhost:3000/google/oauth2callback'
    },
    async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
      };
    }
  );

  assert.equal(tokens.access_token, 'access');
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.match(calls[0].options.body.toString(), /grant_type=authorization_code/);
});

test('refreshAccessToken uses refresh_token grant', async () => {
  const tokens = await refreshAccessToken(
    'refresh-token',
    { clientId: 'client-id', clientSecret: 'client-secret' },
    async () => ({
      ok: true,
      json: async () => ({ access_token: 'new-access', expires_in: 3600 })
    })
  );

  assert.equal(tokens.access_token, 'new-access');
});

test('searchDriveFiles searches PDFs by keyword', async () => {
  const results = await searchDriveFiles('sales confirmation Hong Kong', 'access-token', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer access-token');
    assert.match(url, /drive\/v3\/files/);
    return {
      ok: true,
      json: async () => ({
        files: [
          {
            id: 'file-id',
            name: 'IH260512SB.pdf',
            mimeType: 'application/pdf',
            webViewLink: 'https://drive.google.com/file/d/file-id'
          }
        ]
      })
    };
  });

  assert.equal(results[0].name, 'IH260512SB.pdf');
});

test('searchDriveFolders searches folder names', async () => {
  const results = await searchDriveFolders('HKMI UK', 'access-token', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer access-token');
    assert.match(url, /mimeType\+%3D\+%27application%2Fvnd\.google-apps\.folder%27/);
    assert.match(url, /name\+contains\+%27HKMI%27/);
    return {
      ok: true,
      json: async () => ({
        files: [
          {
            id: 'folder-id',
            name: 'HKMI UK',
            mimeType: 'application/vnd.google-apps.folder',
            webViewLink: 'https://drive.google.com/drive/folders/folder-id'
          }
        ]
      })
    };
  });

  assert.equal(results[0].name, 'HKMI UK');
});

test('listDriveFolderChildren lists visible folder contents', async () => {
  const results = await listDriveFolderChildren('folder-id', 'access-token', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer access-token');
    assert.match(url, /%27folder-id%27\+in\+parents/);
    assert.match(url, /orderBy=folder%2Cname/);
    return {
      ok: true,
      json: async () => ({
        files: [{ id: 'child-id', name: 'price-list.pdf', mimeType: 'application/pdf' }]
      })
    };
  });

  assert.equal(results[0].name, 'price-list.pdf');
});

test('Drive lookup helpers detect folder questions and summarize results', () => {
  assert.equal(isDriveLookupRequest('HKMI UKフォルダ見れる？'), true);
  assert.equal(buildDriveLookupQuery('HKMI UKフォルダ見れる？'), 'HKMI UK');

  const summary = summarizeDriveLookup({
    query: 'HKMI UK',
    folders: [
      {
        name: 'HKMI UK',
        webViewLink: 'https://drive.google.com/drive/folders/folder-id'
      }
    ],
    childrenByFolder: [[{ name: 'spec.pdf' }, { name: 'quote.xlsx' }]]
  });

  assert.match(summary, /HKMI UK/);
  assert.match(summary, /spec\.pdf/);
  assert.match(summary, /quote\.xlsx/);
});

test('summarizeDriveFiles formats Drive search results', () => {
  const summary = summarizeDriveFiles([
    {
      name: 'IH260512SB.pdf',
      mimeType: 'application/pdf',
      webViewLink: 'https://drive.google.com/file/d/file-id'
    }
  ]);

  assert.match(summary, /Google Drive search results/);
  assert.match(summary, /IH260512SB\.pdf/);
});
