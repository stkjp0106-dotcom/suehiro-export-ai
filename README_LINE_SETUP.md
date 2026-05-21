# SUEHIRO AI LINE webhook

This is the first minimal LINE bot server.

Current behavior:

```text
LINE message
-> Node.js webhook server
-> replies: 受信しました。確認して返信します。
```

## 1. Create `.env`

Copy `.env.example` to `.env` and fill in the values from LINE Developers.

```env
LINE_CHANNEL_SECRET=your_channel_secret
LINE_CHANNEL_ACCESS_TOKEN=your_channel_access_token
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.4-mini
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/google/oauth2callback
PORT=3000
```

Do not paste these secret values into chat.

## 2. Run tests

```bash
node --test test/line.test.mjs test/openai.test.mjs test/knowledge.test.mjs test/google-drive.test.mjs
```

## 3. Start the local server

```bash
node server.mjs
```

Open this on the same PC to check the server:

```text
http://localhost:3000/
```

## 4. Authorize Google Drive, if needed

Open this while the server is running:

```text
http://localhost:3000/google/auth
```

The app saves the OAuth token under `.tokens/`.

## 5. Make a public webhook URL

LINE cannot call `localhost` directly. Use a tunnel tool such as ngrok or Cloudflare Tunnel.

The webhook URL you enter in LINE Developers should end with `/webhook`.

Example:

```text
https://xxxx.ngrok-free.app/webhook
```

or:

```text
https://xxxx.trycloudflare.com/webhook
```

## 6. LINE Developers settings

In the `SUEHIRO AI` Messaging API channel:

1. Open the `Messaging API` tab.
2. Set `Webhook URL` to the public tunnel URL ending in `/webhook`.
3. Turn `Use webhook` on.
4. Disable auto-reply messages if LINE's default replies conflict with the bot.
