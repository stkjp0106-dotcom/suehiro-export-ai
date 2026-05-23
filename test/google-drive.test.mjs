import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDriveDocumentLookupQuery,
  buildDriveLookupQuery,
  buildGoogleAuthUrl,
  downloadDriveFile,
  exchangeCodeForTokens,
  extractAmountCandidates,
  extractDriveReference,
  filterDriveDocumentFiles,
  findDriveContextFile,
  findDriveInvoiceFiles,
  getGoogleConfig,
  isDriveDocumentLookupRequest,
  isDriveFileDetailRequest,
  isGoogleAuthExpiredError,
  isDriveInvoiceLookupRequest,
  isDriveLookupRequest,
  listDriveFolderChildren,
  refreshAccessToken,
  searchDriveFolders,
  searchDriveFiles,
  summarizeDriveDocumentFiles,
  summarizeDriveInvoiceFiles,
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

test('getGoogleConfig prefers public Railway callback over localhost redirect', () => {
  const config = getGoogleConfig({
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/google/oauth2callback',
    RAILWAY_PUBLIC_DOMAIN: 'suehiro-export-ai-production.up.railway.app'
  });

  assert.equal(
    config.redirectUri,
    'https://suehiro-export-ai-production.up.railway.app/google/oauth2callback'
  );
});

test('isGoogleAuthExpiredError detects expired refresh token failures', () => {
  assert.equal(
    isGoogleAuthExpiredError(new Error('Google token request failed: 400 {"error":"invalid_grant"}')),
    true
  );
  assert.equal(isGoogleAuthExpiredError(new Error('Google Drive search failed: 403 insufficientPermissions')), false);
});

test('getValidAccessToken falls back to saved tokens when env refresh token is expired', async () => {
  const tempTokenPath = `./.tmp-google-token-${Date.now()}.json`;
  const { writeFileSync, unlinkSync } = await import('node:fs');
  writeFileSync(tempTokenPath, JSON.stringify({ refresh_token: 'saved-refresh' }), 'utf8');

  try {
    const { getValidAccessToken } = await import('../src/google-drive.mjs');
    const calls = [];
    const token = await getValidAccessToken(
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'expired-env-refresh',
        tokenPath: tempTokenPath
      },
      async (_url, options) => {
        const body = options.body.toString();
        calls.push(body);
        if (body.includes('expired-env-refresh')) {
          return { ok: false, text: async () => '{"error":"invalid_grant"}' };
        }
        return { ok: true, json: async () => ({ access_token: 'saved-access', expires_in: 3600 }) };
      }
    );

    assert.equal(token, 'saved-access');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /expired-env-refresh/);
    assert.match(calls[1], /saved-refresh/);
  } finally {
    unlinkSync(tempTokenPath);
  }
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

test('downloadDriveFile downloads Drive file media', async () => {
  const buffer = await downloadDriveFile('file-id', 'access-token', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer access-token');
    assert.match(url, /drive\/v3\/files\/file-id\?alt=media/);
    return {
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('PDF text').buffer
    };
  });

  assert.equal(buffer.toString('utf8'), 'PDF text');
});

test('Drive detail helpers understand follow-up invoice amount questions', () => {
  const context = {
    files: [
      {
        id: 'can015',
        name: 'CAN015 INV.pdf',
        mimeType: 'application/pdf',
        webViewLink: 'https://drive.google.com/file/d/can015'
      },
      {
        id: 'can014',
        name: 'CAN014 Commercial Invoice .pdf',
        mimeType: 'application/pdf'
      }
    ]
  };

  assert.equal(isDriveFileDetailRequest('CAN015の金額だね', context), true);
  assert.equal(isDriveFileDetailRequest('014は？', context), true);
  assert.equal(extractDriveReference('CAN015の金額だね'), 'CAN015');
  assert.equal(findDriveContextFile('014は？', context.files).id, 'can014');
});

test('Drive invoice lookup helpers filter recent invoice files from context', () => {
  const context = {
    files: [
      {
        id: 'sheet',
        name: 'Golden Fine Food スプレッドシート',
        mimeType: 'application/vnd.google-apps.spreadsheet',
        webViewLink: 'https://docs.google.com/spreadsheets/d/sheet',
        modifiedTime: '2026-05-20T00:00:00Z'
      },
      {
        id: 'inv011',
        name: '[INV011(0510)]',
        mimeType: 'application/pdf',
        webViewLink: 'https://drive.google.com/file/d/inv011',
        modifiedTime: '2026-05-21T00:00:00Z'
      },
      {
        id: 'can015',
        name: 'CAN015 INV.pdf',
        mimeType: 'application/pdf',
        webViewLink: 'https://drive.google.com/file/d/can015',
        modifiedTime: '2026-05-23T00:00:00Z'
      }
    ]
  };

  assert.equal(isDriveInvoiceLookupRequest('直近の取引INVだけして', context), true);
  assert.equal(isDriveInvoiceLookupRequest('請求書だよ', context), true);
  assert.equal(isDriveInvoiceLookupRequest('こんにちは', context), false);

  const invoiceFiles = findDriveInvoiceFiles('直近の取引INVだけして', context.files);
  assert.deepEqual(invoiceFiles.map((file) => file.id), ['can015', 'inv011']);

  const summary = summarizeDriveInvoiceFiles(invoiceFiles);
  assert.match(summary, /請求書\/Invoice候補/);
  assert.match(summary, /CAN015 INV\.pdf/);
  assert.match(summary, /\[INV011\(0510\)\]/);
});

test('Drive document lookup helpers handle PL requests directly', () => {
  const files = [
    {
      id: 'inv',
      name: '[Golden Fine Food INV011(0510).pdf]',
      mimeType: 'application/pdf',
      webViewLink: 'https://drive.google.com/file/d/inv',
      modifiedTime: '2026-05-23T00:00:00Z'
    },
    {
      id: 'pl',
      name: '[Golden Fine Food PL011(0510).pdf]',
      mimeType: 'application/pdf',
      webViewLink: 'https://drive.google.com/file/d/pl',
      modifiedTime: '2026-05-22T00:00:00Z'
    }
  ];

  assert.equal(isDriveDocumentLookupRequest('Golden fine foodsの前回のPLだして'), true);
  assert.equal(isDriveDocumentLookupRequest('PL'), false);
  assert.equal(buildDriveDocumentLookupQuery('Golden fine foodsの前回のPLだして'), 'Golden fine foods PL Packing List');

  const selected = filterDriveDocumentFiles('Golden fine foodsの前回のPLだして', files);
  assert.deepEqual(selected.map((file) => file.id), ['pl']);

  const summary = summarizeDriveDocumentFiles({
    requestText: 'Golden fine foodsの前回のPLだして',
    query: 'Golden fine foods PL Packing List',
    files: selected
  });
  assert.match(summary, /PL \/ Packing List候補/);
  assert.match(summary, /Golden Fine Food PL011/);
  assert.doesNotMatch(summary, /接続されていません/);
});

test('extractAmountCandidates prefers total amount lines', () => {
  const candidates = extractAmountCandidates([
    'Unit price USD 12.50',
    'Subtotal USD 1,200.00',
    'Grand Total USD 1,350.00',
    'Bank: Example Bank'
  ].join('\n'));

  assert.equal(candidates[0], 'Grand Total USD 1,350.00');
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
