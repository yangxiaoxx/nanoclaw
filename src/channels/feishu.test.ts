import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FeishuChannel } from './feishu.js';

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockCreate = vi.fn().mockResolvedValue({ data: {} });

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockClient {
    im = { message: { create: mockCreate } };
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
    LoggerLevel: { info: 'info' },
  };
});

describe('FeishuChannel', () => {
  let channel: FeishuChannel;
  const mockOnMessage = vi.fn();
  const mockOnChatMetadata = vi.fn();
  const mockRegisteredGroups = vi.fn(() => ({
    'fs:oc_test123': {
      name: 'Test Chat',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00Z',
      requiresTrigger: false,
    },
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    channel = new FeishuChannel(
      'cli_test123',
      'test_secret',
      'test_token',
      {
        onMessage: mockOnMessage,
        onChatMetadata: mockOnChatMetadata,
        registeredGroups: mockRegisteredGroups,
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
});
