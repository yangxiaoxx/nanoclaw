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

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;
  private verificationToken: string;
  private connected = false;

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

  async connect(): Promise<void> {
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });

    // Set up event dispatcher for receiving messages
    const eventDispatcher = new lark.EventDispatcher({
      verificationToken: this.verificationToken,
    }).register({
      'im.message.receive_v1': async (data) => {
        const message = data.message;
        if (!message) return;

        const chatId = message.chat_id;
        const chatJid = `fs:${chatId}`;
        const messageId = message.message_id;
        const senderId = data.sender?.sender_id?.user_id || '';
        const senderName =
          data.sender?.sender_id?.user_id || data.sender?.sender_id?.open_id || 'Unknown';
        const timestamp = new Date(parseInt(message.create_time) * 1000).toISOString();

        // Parse message content
        let content = '';
        try {
          const msgContent = JSON.parse(message.content);
          content = msgContent.text || '';
        } catch {
          content = message.content || '';
        }

        // Get chat type
        const chatType = message.chat_type;
        const isGroup = chatType === 'group';

        // Store chat metadata
        this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);

        // Check if registered
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          logger.debug({ chatJid }, 'Message from unregistered Feishu chat');
          return;
        }

        // Handle @mentions in groups - convert to trigger format
        if (isGroup && message.mentions) {
          const mentions = message.mentions;
          const botMentioned = mentions.some((m: any) => m.id?.user_id === this.appId);
          if (botMentioned && !TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }

        // Deliver message
        this.opts.onMessage(chatJid, {
          id: messageId,
          chat_jid: chatJid,
          sender: senderId,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });

        logger.info({ chatJid, sender: senderName }, 'Feishu message stored');
      },
    });

    // Start WebSocket client for long connection
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    await this.wsClient.start({ eventDispatcher });
    this.connected = true;

    logger.info({ appId: this.appId }, 'Feishu WebSocket connected');
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
      logger.error({ err: err.message, jid }, 'Failed to send Feishu message');
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
