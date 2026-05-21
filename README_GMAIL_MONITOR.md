# Gmail AI Draft Monitor

This worker monitors the Gmail mailbox behind `sales@suehirotrd.com` and saves AI reply drafts in Gmail.

It does not send emails automatically.

## Runtime

```bash
npm run gmail:worker
```

Railway uses `railway.toml`:

```bash
npm run gmail:worker
```

## Environment variables

Set these in Railway Variables:

```env
GMAIL_MAILBOX=sales@suehirotrd.com
GMAIL_POLL_SECONDS=60
GMAIL_STATE_PATH=.state/gmail-monitor.json
GMAIL_DRAFT_LABEL_NAME=AI Reply
GMAIL_PROCESS_EXISTING_ON_FIRST_RUN=false
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.4-mini
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
GOOGLE_REFRESH_TOKEN=your_google_refresh_token
```

For persistent Gmail history state on Railway, attach a Railway volume and set:

```env
GMAIL_STATE_PATH=/data/gmail-monitor.json
```

## Google OAuth setup

Create or reuse a Google Cloud OAuth client and enable Gmail API.

The OAuth consent must include:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`
- `https://www.googleapis.com/auth/gmail.modify`

To get the refresh token locally:

```bash
npm run gmail:auth
```

Open `http://localhost:3002/`, sign in as the Google account that owns `sales@suehirotrd.com`, and copy the printed `GOOGLE_REFRESH_TOKEN` to Railway.

## Behavior

1. Refresh a Google OAuth access token.
2. Poll Gmail history for new Inbox messages.
3. Fetch the full message.
4. Ask OpenAI to create a reply draft.
5. Create a Gmail draft in the same thread.
6. Add the `AI Reply` label to the draft message.
7. Save the Gmail history ID and processed message IDs.

On the first run, the worker saves a baseline history ID and does not create drafts for existing Inbox mail unless `GMAIL_PROCESS_EXISTING_ON_FIRST_RUN=true`.

## Future YES-to-send design

Sending is intentionally not wired into the monitor loop.

A later feature can:

1. Detect an approval phrase such as `YES`.
2. Look up the matching draft ID.
3. Call Gmail API `drafts.send`.

Do not add sending until human approval rules are explicit.
