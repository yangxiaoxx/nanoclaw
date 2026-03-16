import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FeishuChannel } from './feishu.js';

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockMessageCreate = vi.fn().mockResolvedValue({ data: {} });
const mockImageCreate = vi.fn().mockResolvedValue({ image_key: 'img_uploaded' });
const mockMessageResourceGet = vi.fn();
const mockChatGet = vi.fn().mockResolvedValue({ data: { name: 'Test Chat' } });
const mockUserGet = vi.fn().mockResolvedValue({ data: { user: { name: 'Tester' } } });
const mockRequest = vi.fn().mockResolvedValue({ bot: { open_id: 'ou_bot' } });

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockClient {
    im = {
      message: { create: mockMessageCreate },
      image: { create: mockImageCreate },
      messageResource: { get: mockMessageResourceGet },
      chat: { get: mockChatGet },
    };
    contact = {
      user: { get: mockUserGet },
    };
    request = mockRequest;
  }
  class MockEventDispatcher {
    register() {
      return this;
    }
  }
  class MockWSClient {
    start = mockStart;
    close = mockStop;
  }
  return {
    Client: MockClient,
    EventDispatcher: MockEventDispatcher,
    WSClient: MockWSClient,
    AppType: { SelfBuild: 'selfBuild' },
    Domain: { Feishu: 'https://open.feishu.cn' },
  };
});

describe('FeishuChannel', () => {
  let channel: FeishuChannel;
  const mockOnMessage = vi.fn();
  const mockOnChatMetadata = vi.fn();
  const testFolder = 'feishu-test';

  const mockRegisteredGroups = vi.fn(() => ({
    'fs:oc_test123': {
      name: 'Test Chat',
      folder: testFolder,
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00Z',
      requiresTrigger: false,
    },
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageResourceGet.mockResolvedValue({
      headers: { 'content-type': 'image/png' },
      writeFile: vi.fn(async (filePath: string) => {
        fs.writeFileSync(filePath, Buffer.from('test-image'));
      }),
    });
    fs.rmSync(path.join(process.cwd(), 'groups', testFolder), {
      recursive: true,
      force: true,
    });

    channel = new FeishuChannel(
      'cli_test123',
      'test_secret',
      'test_token',
      {
        onMessage: mockOnMessage,
        onChatMetadata: mockOnChatMetadata,
        registeredGroups: mockRegisteredGroups,
        registerGroup: vi.fn(),
      },
    );
  });

  it('should initialize with correct name', () => {
    expect(channel.name).toBe('feishu');
  });

  it('should identify Feishu JIDs', () => {
    expect(channel.ownsJid('fs:oc_123')).toBe(true);
    expect(channel.ownsJid('tg:123')).toBe(false);
    expect(channel.ownsJid('123@s.whatsapp.net')).toBe(false);
  });

  it('should report not connected initially', () => {
    expect(channel.isConnected()).toBe(false);
  });

  it('should report connected after connect', async () => {
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
  });

  it('should disconnect properly', async () => {
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it('sends image from local path with optional caption', async () => {
    await channel.connect();
    const imagePath = path.join(process.cwd(), 'groups', testFolder, 'out.png');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, Buffer.from('image-bytes'));

    await channel.sendImage('fs:oc_test123', {
      path: imagePath,
      caption: 'image caption',
    });

    expect(mockImageCreate).toHaveBeenCalledTimes(1);
    expect(mockMessageCreate).toHaveBeenCalledTimes(2);
    expect(mockMessageCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          msg_type: 'image',
          content: JSON.stringify({ image_key: 'img_uploaded' }),
        }),
      }),
    );
  });

  it('stores inbound image as a message with container path', async () => {
    await channel.connect();

    await (channel as any).handleMessage({
      sender: {
        sender_id: { open_id: 'ou_user' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_msg_123',
        create_time: String(Date.now()),
        chat_id: 'oc_test123',
        chat_type: 'group',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_source_key' }),
      },
    });

    expect(mockOnMessage).toHaveBeenCalledTimes(1);
    const delivered = mockOnMessage.mock.calls[0][1];
    expect(delivered.content).toContain('[Feishu image]');
    expect(delivered.content).toContain('/workspace/group/inbox/feishu/');

    const inboxDir = path.join(process.cwd(), 'groups', testFolder, 'inbox', 'feishu');
    expect(fs.existsSync(inboxDir)).toBe(true);
    expect(fs.readdirSync(inboxDir).length).toBeGreaterThan(0);
  });

  it('applies trigger prefix to image sent shortly after @mention', async () => {
    await channel.connect();
    const now = Date.now();

    await (channel as any).handleMessage({
      sender: {
        sender_id: { open_id: 'ou_user' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_msg_trigger',
        create_time: String(now),
        chat_id: 'oc_test123',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 看图' }),
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot' },
            name: 'Andy',
          },
        ],
      },
    });

    await (channel as any).handleMessage({
      sender: {
        sender_id: { open_id: 'ou_user' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_msg_image_after_trigger',
        create_time: String(now + 1000),
        chat_id: 'oc_test123',
        chat_type: 'group',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_source_key_2' }),
      },
    });

    expect(mockOnMessage).toHaveBeenCalledTimes(2);
    const imageMsg = mockOnMessage.mock.calls[1][1];
    expect(imageMsg.content.startsWith('@Andy [Feishu image]')).toBe(true);
  });

  it('skips unsupported inbound message types', async () => {
    await channel.connect();

    await (channel as any).handleMessage({
      sender: {
        sender_id: { open_id: 'ou_user' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_msg_unsupported',
        create_time: String(Date.now()),
        chat_id: 'oc_test123',
        chat_type: 'group',
        message_type: 'audio',
        content: '{}',
      },
    });

    expect(mockOnMessage).not.toHaveBeenCalled();
  });
});
