# config.ts Intent

## What Changed

Added Feishu (Lark) configuration exports:
- `FEISHU_APP_ID`: Feishu app ID from environment
- `FEISHU_APP_SECRET`: Feishu app secret from environment
- `FEISHU_VERIFICATION_TOKEN`: Feishu verification token from environment
- `FEISHU_ONLY`: Boolean flag to use Feishu exclusively (disables WhatsApp)

## Invariants

- All existing exports remain unchanged
- Environment variables follow the pattern: `export const VAR_NAME = process.env.VAR_NAME || '';`
- Boolean flags use: `export const FLAG = process.env.FLAG === 'true';`
- No runtime validation - missing values result in empty strings or false

## Merge Strategy

Add these four exports anywhere in the file, typically grouped with other channel configs (near TELEGRAM_BOT_TOKEN if it exists).
