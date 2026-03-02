import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface FeishuMention {
  key: string;
  id: { union_id?: string; user_id?: string; open_id?: string };
  name: string;
  tenant_key?: string;
}

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

    // Only handle text messages for now
    if (message.message_type !== 'text') {
      logger.debug(
        { type: message.message_type },
        'Skipping non-text Feishu message',
      );
      return;
    }

    const chatId = message.chat_id;
    const chatJid = `fs:${chatId}`;
    const messageId = message.message_id;
    const senderOpenId = sender.sender_id?.open_id || '';
    const timestamp = new Date(
      parseInt(message.create_time),
    ).toISOString();
    const isGroup = message.chat_type === 'group';

    // Parse message content
    let content = '';
    try {
      const msgContent = JSON.parse(message.content);
      content = msgContent.text || '';
    } catch {
      content = message.content || '';
    }

    // Resolve mentions: replace placeholders with real names, detect bot @mention
    let botMentioned = false;
    if (message.mentions && message.mentions.length > 0) {
      const result = this.resolveMentions(content, message.mentions);
      content = result.text;
      botMentioned = result.botMentioned;
    }

    // Resolve sender name and chat name in parallel
    const [senderName, chatName] = await Promise.all([
      this.resolveUserName(senderOpenId),
      this.resolveChatName(chatId),
    ]);

    // Store chat metadata with resolved chat name
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'feishu', isGroup);

    // Check if registered
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.info(
        { chatJid, chatName },
        'Message from unregistered Feishu chat',
      );
      return;
    }

    // If bot was @mentioned in a group, ensure trigger pattern is present
    if (isGroup && botMentioned && !TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
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
