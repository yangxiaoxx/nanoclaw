import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  Channel,
  OutboundImage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

interface FeishuMention {
  key: string;
  id: { union_id?: string; user_id?: string; open_id?: string };
  name: string;
  tenant_key?: string;
}

const FEISHU_MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const FEISHU_IMAGE_FETCH_TIMEOUT_MS = 20_000;
const FEISHU_MENTION_IMAGE_GRACE_MS = 60_000;

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;
  private verificationToken: string;
  private connected = false;
  private botOpenId = '';
  private userNameCache = new Map<string, string>();
  private chatNameCache = new Map<string, string>();
  private recentMentions = new Map<string, number>();

  constructor(
    appId: string,
    appSecret: string,
    verificationToken: string,
    opts: FeishuChannelOpts,
  ) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.verificationToken = verificationToken;
    this.opts = opts;
  }

  /** Fetch the bot's open_id via tenant access token for mention detection. */
  private async fetchBotOpenId(): Promise<void> {
    if (!this.client) return;
    try {
      // Use the SDK's internal token manager to get a tenant access token,
      // then call the bot info endpoint directly.
      const resp: any = await this.client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info/',
      });
      const botOpenId = resp?.bot?.open_id;
      if (botOpenId) {
        this.botOpenId = botOpenId;
        logger.info({ botOpenId: this.botOpenId }, 'Fetched bot open_id');
      }
    } catch (err: any) {
      logger.warn(
        { err: err.message },
        'Failed to fetch bot open_id, falling back to name-based mention detection',
      );
    }
  }

  /** Resolve a user's display name from open_id, with caching. */
  private async resolveUserName(openId: string): Promise<string> {
    if (!openId) return 'Unknown';
    const cached = this.userNameCache.get(openId);
    if (cached) return cached;
    if (!this.client) return openId;

    try {
      const resp = await this.client.contact.user.get({
        params: { user_id_type: 'open_id' },
        path: { user_id: openId },
      });
      const name = resp.data?.user?.name || openId;
      this.userNameCache.set(openId, name);
      return name;
    } catch (err: any) {
      logger.debug({ openId, err: err.message }, 'Failed to resolve user name');
      // Cache the fallback to avoid repeated failures
      this.userNameCache.set(openId, openId);
      return openId;
    }
  }

  /** Resolve a chat's display name from chat_id, with caching. */
  private async resolveChatName(
    chatId: string,
  ): Promise<string | undefined> {
    const cached = this.chatNameCache.get(chatId);
    if (cached) return cached;
    if (!this.client) return undefined;

    try {
      const resp = await this.client.im.chat.get({
        path: { chat_id: chatId },
      });
      const name = resp.data?.name;
      if (name) {
        this.chatNameCache.set(chatId, name);
      }
      return name;
    } catch (err: any) {
      logger.debug(
        { chatId, err: err.message },
        'Failed to resolve chat name',
      );
      return undefined;
    }
  }

  /**
   * Replace @mention placeholders (@_user_1 etc.) with real names
   * and detect if the bot was mentioned.
   */
  private resolveMentions(
    text: string,
    mentions: FeishuMention[],
  ): { text: string; botMentioned: boolean } {
    let botMentioned = false;
    let resolved = text;

    for (const m of mentions) {
      const isBotMention = this.botOpenId
        ? m.id.open_id === this.botOpenId
        : m.name.toLowerCase() === ASSISTANT_NAME.toLowerCase();

      if (isBotMention) {
        botMentioned = true;
        // Remove the bot mention placeholder from text
        resolved = resolved.replace(m.key, '').trim();
      } else {
        // Replace user mention placeholder with real name
        resolved = resolved.replace(m.key, `@${m.name}`);
      }
    }

    return { text: resolved, botMentioned };
  }

  async connect(): Promise<void> {
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });

    // Fetch bot's open_id for mention detection
    await this.fetchBotOpenId();

    // Set up event dispatcher for receiving messages
    const eventDispatcher = new lark.EventDispatcher({
      verificationToken: this.verificationToken,
    }).register({
      'im.message.receive_v1': async (data) => {
        try {
          await this.handleMessage(data);
        } catch (err: any) {
          logger.error(
            { err: err.message },
            'Error handling Feishu message event',
          );
        }
      },
    });

    // Start WebSocket client for long connection
    // The SDK handles reconnection automatically with exponential backoff.
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    await this.wsClient.start({ eventDispatcher });
    this.connected = true;

    logger.info(
      { appId: this.appId, botOpenId: this.botOpenId || '(unknown)' },
      'Feishu WebSocket connected',
    );
  }

  private parseMessageContent(content: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to empty object
    }
    return {};
  }

  private safeImageExtension(headers: any): string {
    const contentType = String(headers?.['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (contentType === 'image/jpeg') return '.jpg';
    if (contentType === 'image/png') return '.png';
    if (contentType === 'image/webp') return '.webp';
    if (contentType === 'image/gif') return '.gif';
    if (contentType === 'image/bmp') return '.bmp';
    if (contentType === 'image/tiff') return '.tiff';
    if (contentType === 'image/x-icon' || contentType === 'image/vnd.microsoft.icon')
      return '.ico';
    return '.img';
  }

  private async buildInboundImageContent(
    groupFolder: string,
    messageId: string,
    timestamp: string,
    rawContent: string,
  ): Promise<string> {
    if (!this.client) {
      return '[Feishu image] (client unavailable for download)';
    }

    const parsed = this.parseMessageContent(rawContent);
    const imageKey = String(parsed.image_key || parsed.file_key || '').trim();
    if (!imageKey) {
      logger.warn({ messageId }, 'Feishu image message missing image_key');
      return '[Feishu image]';
    }

    try {
      const imageResp = await this.client.im.messageResource.get({
        params: { type: 'image' },
        path: { message_id: messageId, file_key: imageKey },
      });

      const inboxDir = path.join(
        resolveGroupFolderPath(groupFolder),
        'inbox',
        'feishu',
      );
      await fs.promises.mkdir(inboxDir, { recursive: true });

      const safeMessageId = messageId.replace(/[^a-zA-Z0-9._-]/g, '_');
      const safeImageKey = imageKey.replace(/[^a-zA-Z0-9._-]/g, '_');
      const safeTimestamp = timestamp.replace(/[:.]/g, '-');
      const extension = this.safeImageExtension(imageResp.headers);
      const fileName = `${safeTimestamp}-${safeMessageId}-${safeImageKey.slice(-12)}${extension}`;
      const hostPath = path.join(inboxDir, fileName);
      await imageResp.writeFile(hostPath);

      const containerPath = path.join('/workspace/group', 'inbox', 'feishu', fileName);
      return `[Feishu image] ${containerPath}`;
    } catch (err: any) {
      logger.error(
        { err: err?.message, messageId, imageKey },
        'Failed to download inbound Feishu image',
      );
      return '[Feishu image] (download failed)';
    }
  }

  private async readImageBufferFromPath(filePath: string): Promise<Buffer> {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`Image path is not a file: ${filePath}`);
    }
    if (stats.size <= 0) {
      throw new Error(`Image file is empty: ${filePath}`);
    }
    if (stats.size > FEISHU_MAX_IMAGE_BYTES) {
      throw new Error(
        `Image file exceeds Feishu limit (${FEISHU_MAX_IMAGE_BYTES} bytes): ${filePath}`,
      );
    }
    return fs.promises.readFile(filePath);
  }

  private async readImageBufferFromUrl(url: string): Promise<Buffer> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid image URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
    }

    const resp = await fetch(url, {
      signal: AbortSignal.timeout(FEISHU_IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      throw new Error(`Image URL request failed: ${resp.status} ${resp.statusText}`);
    }

    const contentLength = Number(resp.headers.get('content-length') || '0');
    if (contentLength > FEISHU_MAX_IMAGE_BYTES) {
      throw new Error(
        `Image URL exceeds Feishu limit (${FEISHU_MAX_IMAGE_BYTES} bytes)`,
      );
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length <= 0) {
      throw new Error('Image URL returned empty content');
    }
    if (buffer.length > FEISHU_MAX_IMAGE_BYTES) {
      throw new Error(
        `Image URL payload exceeds Feishu limit (${FEISHU_MAX_IMAGE_BYTES} bytes)`,
      );
    }
    return buffer;
  }

  private pruneRecentMentions(nowMs: number): void {
    for (const [key, ts] of this.recentMentions.entries()) {
      if (nowMs - ts > FEISHU_MENTION_IMAGE_GRACE_MS) {
        this.recentMentions.delete(key);
      }
    }
  }

  private async handleMessage(data: {
    sender: {
      sender_id?: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      sender_type: string;
      tenant_key?: string;
    };
    message: {
      message_id: string;
      create_time: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      mentions?: FeishuMention[];
    };
  }): Promise<void> {
    const { message, sender } = data;

    // Skip messages from bots (including ourselves)
    if (sender.sender_type === 'app') return;

    const chatId = message.chat_id;
    const chatJid = `fs:${chatId}`;
    const messageId = message.message_id;
    const senderOpenId = sender.sender_id?.open_id || '';
    const messageTsMs = parseInt(message.create_time, 10);
    this.pruneRecentMentions(messageTsMs);
    const timestamp = new Date(
      messageTsMs,
    ).toISOString();
    const isGroup = message.chat_type === 'group';
    const parsedContent = this.parseMessageContent(message.content);
    const mentionKey = `${chatJid}:${senderOpenId}`;

    // Resolve sender name and chat name in parallel so metadata always gets a friendly name.
    const [senderName, chatName] = await Promise.all([
      this.resolveUserName(senderOpenId),
      this.resolveChatName(chatId),
    ]);

    // Store chat metadata with resolved chat name
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'feishu', isGroup);

    // Check if registered, auto-register all Feishu chats
    let group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      const prefix = isGroup ? 'feishu-group' : 'feishu-dm';
      const folder = `${prefix}-${chatId.replace(/[^a-zA-Z0-9]/g, '-')}`;
      group = {
        name: chatName || chatJid,
        folder,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: timestamp,
        requiresTrigger: !isGroup ? false : true,
      };
      logger.info({ chatJid, chatName, folder, isGroup }, 'Auto-registering Feishu chat');
      this.opts.registerGroup(chatJid, group);
      this.opts.onChatMetadata(chatJid, timestamp, chatName || chatJid, 'feishu', isGroup);
    }

    let content = '';
    if (message.message_type === 'text') {
      content =
        typeof parsedContent.text === 'string'
          ? parsedContent.text
          : message.content || '';

      let botMentioned = false;
      if (message.mentions && message.mentions.length > 0) {
        const result = this.resolveMentions(content, message.mentions);
        content = result.text;
        botMentioned = result.botMentioned;
      }

      // If bot was @mentioned in a group, ensure trigger pattern is present.
      if (isGroup && botMentioned && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      if (isGroup && botMentioned) {
        this.recentMentions.set(mentionKey, messageTsMs);
      }
    } else if (message.message_type === 'image') {
      content = await this.buildInboundImageContent(
        group.folder,
        messageId,
        timestamp,
        message.content,
      );
      // Feishu cannot mix @mention and image in one message, so allow a short
      // grace window where an image right after an @mention is treated as triggered.
      const lastMentionAt = this.recentMentions.get(mentionKey);
      if (
        isGroup &&
        lastMentionAt &&
        messageTsMs >= lastMentionAt &&
        messageTsMs - lastMentionAt <= FEISHU_MENTION_IMAGE_GRACE_MS &&
        !TRIGGER_PATTERN.test(content)
      ) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    } else {
      logger.debug(
        { type: message.message_type, chatJid },
        'Skipping unsupported Feishu message type',
      );
      return;
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: messageId,
      chat_jid: chatJid,
      sender: senderOpenId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, sender: senderName, chatName },
      'Feishu message stored',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error('Feishu client not connected');
    }

    const chatId = jid.replace('fs:', '');

    try {
      await this.client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      logger.info({ jid, textLength: text.length }, 'Feishu message sent');
    } catch (err: any) {
      logger.error(
        { err: err.message, jid },
        'Failed to send Feishu message',
      );
      throw err;
    }
  }

  async sendImage(jid: string, image: OutboundImage): Promise<void> {
    if (!this.client) {
      throw new Error('Feishu client not connected');
    }

    const hasPath = typeof image.path === 'string' && image.path.trim().length > 0;
    const hasUrl = typeof image.url === 'string' && image.url.trim().length > 0;
    if ((hasPath ? 1 : 0) + (hasUrl ? 1 : 0) !== 1) {
      throw new Error('sendImage requires exactly one of path or url');
    }

    const chatId = jid.replace('fs:', '');
    const imageSource = hasPath ? image.path!.trim() : image.url!.trim();

    try {
      const imageBuffer = hasPath
        ? await this.readImageBufferFromPath(imageSource)
        : await this.readImageBufferFromUrl(imageSource);

      const uploadResp = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: imageBuffer,
        },
      });
      const imageKey = uploadResp?.image_key;
      if (!imageKey) {
        throw new Error('Feishu image upload did not return image_key');
      }

      await this.client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });

      const caption = typeof image.caption === 'string' ? image.caption.trim() : '';
      if (caption) {
        await this.sendMessage(jid, caption);
      }

      logger.info(
        {
          jid,
          hasPath,
          hasUrl,
          imageBytes: imageBuffer.length,
          hasCaption: !!caption,
        },
        'Feishu image sent',
      );
    } catch (err: any) {
      logger.error(
        { err: err?.message, jid, imageSource },
        'Failed to send Feishu image',
      );
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('fs:');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
    }
    this.connected = false;
    this.client = null;
    logger.info('Feishu channel disconnected');
  }
}
