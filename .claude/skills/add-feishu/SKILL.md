---
name: add-feishu
description: Add Feishu (Lark) as a channel. Can replace WhatsApp entirely or run alongside it. Uses event subscription for real-time message delivery.
---

# Add Feishu Channel

This skill adds Feishu (Lark) support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `feishu` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Should Feishu replace WhatsApp or run alongside it?
- **Replace WhatsApp** - Feishu will be the only channel (sets FEISHU_ONLY=true)
- **Alongside** - Both Feishu and WhatsApp channels active

AskUserQuestion: Do you have a Feishu app created, or do you need to create one?

If they have one, collect App ID, App Secret, and Verification Token now. If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-feishu
```

This deterministically:
- Adds `src/channels/feishu.ts` (FeishuChannel class implementing Channel interface)
- Adds `src/channels/feishu.test.ts` (unit tests)
- Three-way merges Feishu support into `src/index.ts` (multi-channel support, findChannel routing)
- Three-way merges Feishu config into `src/config.ts` (FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_VERIFICATION_TOKEN, FEISHU_ONLY exports)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Installs the `@larksuiteoapi/node-sdk` npm dependency
- Updates `.env.example` with Feishu environment variables
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new feishu tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Feishu App (if needed)

If the user doesn't have a Feishu app, tell them:

> I need you to create a Feishu app:
>
> 1. Open https://open.feishu.cn/app (China) or https://open.larksuite.com/app (International)
> 2. Click **Create custom app**
> 3. Fill in app name (e.g., "NanoClaw Assistant") and description
> 4. After creation, go to **Credentials & Basic Info**:
>    - Copy **App ID**
>    - Copy **App Secret**
>    - Copy **Verification Token** (under Event Subscriptions section)
> 5. Go to **Permissions & Scopes**, add these scopes:
>    - `im:message` (Read and send messages)
>    - `im:message.group_at_msg` (Receive group @mentions)
>    - `im:chat` (Get chat info)
> 6. Go to **Event Subscriptions**:
>    - Enable event subscription
>    - Subscribe to: `im.message.receive_v1` (Receive messages)

Wait for the user to provide App ID, App Secret, and Verification Token.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=<their-app-id>
FEISHU_APP_SECRET=<their-app-secret>
FEISHU_VERIFICATION_TOKEN=<their-verification-token>
```

If they chose to replace WhatsApp:

```bash
FEISHU_ONLY=true
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Add your bot to a Feishu group or open a private chat with it
> 2. Send `/chatid` — it will reply with the chat ID
> 3. For groups: make sure the bot is added to the group first

Wait for the user to provide the chat ID (format: `fs:oc_xxxxx` or `fs:ou_xxxxx`).

### Register the chat

For a main chat (responds to all messages, uses the `main` folder):

```typescript
registerGroup("fs:<chat-id>", {
  name: "<chat-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("fs:<chat-id>", {
  name: "<chat-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Feishu chat:
> - For main chat: Any message works
> - For non-main: `@Andy hello` or @mention the bot
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_VERIFICATION_TOKEN` are set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite (check with: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'fs:%'"`)
3. For non-main chats: message includes trigger pattern
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)
5. App has required permissions enabled in Feishu admin console

### Bot only responds to @mentions in groups

This is expected behavior for Feishu groups. The bot only receives messages where it's @mentioned unless it's the main chat with `requiresTrigger: false`.

### Getting chat ID

If `/chatid` doesn't work:
- Verify credentials are correct
- Check bot is started: `tail -f logs/nanoclaw.log`
- Ensure event subscription is enabled in Feishu app settings

## Removal

To remove Feishu integration:

1. Delete `src/channels/feishu.ts` and `src/channels/feishu.test.ts`
2. Remove `FeishuChannel` import and creation from `src/index.ts`
3. Remove `channels` array and revert to using `whatsapp` directly
4. Remove Feishu config from `src/config.ts`
5. Remove Feishu registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'fs:%'"`
6. Uninstall: `npm uninstall @larksuiteoapi/node-sdk`
7. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
