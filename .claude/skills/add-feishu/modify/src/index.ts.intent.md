# index.ts Intent

## What Changed

Added Feishu channel support alongside WhatsApp:

1. **Import FeishuChannel** from `./channels/feishu.js`
2. **Import Feishu config** (`FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_VERIFICATION_TOKEN`, `FEISHU_ONLY`) from `./config.js`
3. **Initialize FeishuChannel** in `main()` if credentials are present
4. **Add to channels array** so it participates in message routing
5. **Conditional WhatsApp** - skip WhatsApp initialization if `FEISHU_ONLY=true`

## Invariants

- WhatsApp remains the default channel when no other channels are configured
- `channels` array is used for multi-channel routing (already exists if Telegram/Slack/Gmail are installed)
- All channels receive the same callbacks: `onMessage`, `onChatMetadata`, `registeredGroups`
- Channel initialization happens in `main()` before `startMessageLoop()`
- Errors during channel connection are logged but don't crash the process

## Merge Strategy

1. Add `FeishuChannel` import near other channel imports
2. Add Feishu config imports to the config import block
3. In `main()`, after WhatsApp initialization, add Feishu initialization:
   ```typescript
   if (FEISHU_APP_ID && FEISHU_APP_SECRET && FEISHU_VERIFICATION_TOKEN) {
     const feishu = new FeishuChannel(
       FEISHU_APP_ID,
       FEISHU_APP_SECRET,
       FEISHU_VERIFICATION_TOKEN,
       { onMessage, onChatMetadata, registeredGroups: () => registeredGroups }
     );
     await feishu.connect();
     channels.push(feishu);
   }
   ```
4. Wrap WhatsApp initialization in `if (!FEISHU_ONLY)` block
