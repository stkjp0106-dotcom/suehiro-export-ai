# Outlook AI Draft Monitor

This worker monitors `sales@suehirotrd.com` with Microsoft Graph and saves AI reply drafts in Outlook.

It does not send emails automatically.

## Runtime

```bash
npm run outlook:worker
```

Railway uses `railway.toml`:

```bash
npm run outlook:worker
```

## Environment variables

Set these in Railway Variables:

```env
OUTLOOK_MAILBOX=sales@suehirotrd.com
OUTLOOK_POLL_SECONDS=60
OUTLOOK_STATE_PATH=.state/outlook-monitor.json
OUTLOOK_PROCESS_EXISTING_ON_FIRST_RUN=false
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.4-mini
MICROSOFT_TENANT_ID=your_microsoft_tenant_id
MICROSOFT_CLIENT_ID=your_microsoft_app_client_id
MICROSOFT_CLIENT_SECRET=your_microsoft_app_client_secret
```

For persistent delta state on Railway, attach a Railway volume and set:

```env
OUTLOOK_STATE_PATH=/data/outlook-monitor.json
```

## Microsoft Entra app setup

Create an app registration in Microsoft Entra ID and grant Microsoft Graph Application permissions:

- `Mail.Read`
- `Mail.ReadWrite`

Then grant admin consent.

The worker uses the OAuth 2.0 client credentials flow, so it is suitable for Railway and does not require a local PC to stay online.

## Non-admin fallback

If Microsoft 365 admin access is not available, try delegated OAuth instead.

This still requires an app registration, but it does not use Application permissions. The mailbox user signs in once and Railway uses a refresh token after that.

Delegated variables:

```env
MICROSOFT_CLIENT_ID=your_microsoft_app_client_id
MICROSOFT_CLIENT_SECRET=your_microsoft_app_client_secret
MICROSOFT_REFRESH_TOKEN=your_delegated_refresh_token
```

For delegated mode, the worker uses `/me` in Microsoft Graph. The signed-in account must be `sales@suehirotrd.com`.

To get the refresh token:

```bash
npm run outlook:auth
```

Open `http://localhost:3001/`, sign in as `sales@suehirotrd.com`, and copy the printed `MICROSOFT_REFRESH_TOKEN` to Railway.

If the organization blocks user consent, delegated mode will also fail. In that case, a Microsoft 365 admin is required.

## Behavior

1. Get a Microsoft Graph app-only access token.
2. Poll the Inbox delta endpoint for new messages.
3. Ask OpenAI to create a reply draft.
4. Call Graph `createReply` for the original message.
5. Update the created draft body with the AI reply.
6. Save the delta token and processed message IDs.

On the first run, the worker saves a baseline delta token and does not create drafts for existing Inbox mail unless `OUTLOOK_PROCESS_EXISTING_ON_FIRST_RUN=true`.

## Future YES-to-send design

Sending is intentionally isolated in `sendDraft()` in `src/graph.mjs`.

A later feature can:

1. Detect an approval phrase such as `YES`.
2. Look up the matching draft ID.
3. Call `sendDraft(mailbox, draftId, accessToken)`.

Do not wire this into the monitor loop until human approval rules are explicit.
