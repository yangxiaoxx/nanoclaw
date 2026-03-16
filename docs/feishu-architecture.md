# NanoClaw × 飞书集成技术架构方案

## 一、整体架构拓扑

### 1.1 系统分层

NanoClaw 与飞书的集成采用三层架构：

```
┌─────────────────────────────────────────────────────────────────┐
│                        飞书云端                                  │
│  ┌──────────────────┐         ┌───────────────────────────┐     │
│  │  Event Subscription│        │       Open API            │     │
│  │  im.message.receive_v1     │  im.message.create        │     │
│  │     (WebSocket)    │        │  im.image.create          │     │
│  └────────┬───────────┘        │  contact.user.get         │     │
│           │                    │  im.chat.get              │     │
│           │                    │  bot/v3/info              │     │
│           │                    └──────────┬────────────────┘     │
└───────────┼───────────────────────────────┼─────────────────────┘
            │ WebSocket 长连接               │ HTTPS API 调用
            ▼                               ▲
┌───────────────────────────────────────────────────────────────────┐
│                    NanoClaw 主进程 (Node.js)                      │
│                                                                   │
│  ┌─────────────┐  ┌──────────┐  ┌───────────┐  ┌──────────────┐ │
│  │FeishuChannel│  │  Router  │  │   DB      │  │ TaskScheduler│ │
│  │  (Channel)  │  │findChannel│ │  (SQLite) │  │  (cron/once) │ │
│  └──────┬──────┘  └────┬─────┘  └─────┬─────┘  └──────┬───────┘ │
│         │              │              │               │          │
│  ┌──────┴──────────────┴──────────────┴───────────────┴───────┐  │
│  │                     Orchestrator (index.ts)                │  │
│  │        消息循环 · 触发检查 · 游标管理 · 容器调度              │  │
│  └──────────────┬────────────────────────────┬────────────────┘  │
│                 │                            │                   │
│  ┌──────────────┴──────────┐  ┌──────────────┴────────────────┐  │
│  │    GroupQueue            │  │       IPC Watcher             │  │
│  │ 并发控制 · 状态机 · 重试  │  │  轮询 data/ipc/{folder}/      │  │
│  └──────────────┬──────────┘  └──────────────┬────────────────┘  │
└─────────────────┼────────────────────────────┼───────────────────┘
                  │ Docker spawn + stdin        │ 文件系统 IPC (JSON)
                  ▼                            ▲
┌───────────────────────────────────────────────────────────────────┐
│                    Docker 容器 (每群组隔离)                         │
│                                                                   │
│  ┌───────────────────────────────────────────────────────┐       │
│  │                Claude Agent SDK                       │       │
│  │           (claude-agent-sdk + MCP Server)             │       │
│  │                                                       │       │
│  │  MCP Tools:                                           │       │
│  │  send_message · send_image · schedule_task            │       │
│  │  list_tasks · pause/resume/cancel_task                │       │
│  │  register_group                                       │       │
│  │                                                       │       │
│  │  Output: stdout (OUTPUT_START/END_MARKER)             │       │
│  │  IPC:    /workspace/ipc/messages/*.json               │       │
│  └───────────────────────────────────────────────────────┘       │
│                                                                   │
│  Mounts:                                                         │
│  /workspace/group     ← groups/{folder}/       (rw)              │
│  /workspace/ipc       ← data/ipc/{folder}/     (rw)              │
│  /workspace/global    ← groups/global/         (ro)              │
│  /home/node/.claude   ← data/sessions/{folder}/.claude/ (rw)    │
│  /app/src             ← data/sessions/{folder}/agent-runner-src/ │
└───────────────────────────────────────────────────────────────────┘
```

### 1.2 通信机制

| 通信路径 | 协议/方式 | 方向 | 说明 |
|---------|----------|------|------|
| 飞书 → 主进程 | WebSocket (`WSClient`) | 入站 | 实时事件推送，SDK 内置自动重连与指数退避 |
| 主进程 → 飞书 | HTTPS (`Client`) | 出站 | 消息发送、图片上传、用户/群组信息查询 |
| 主进程 → 容器 | Docker stdin (JSON) | 入站 | 传入 prompt、sessionId、chatJid、secrets |
| 容器 → 主进程 | stdout 标记对 | 出站 | `OUTPUT_START_MARKER` + JSON + `OUTPUT_END_MARKER` 流式输出 |
| 容器 ↔ 主进程 | 文件系统 IPC | 双向 | 容器写 JSON 到 `/workspace/ipc/`，主进程轮询读取并删除 |

### 1.3 运行模式

系统支持两种运行模式，由环境变量 `FEISHU_ONLY` 控制：

**飞书独立模式**（`FEISHU_ONLY=true`）：
- 仅启动 FeishuChannel，不初始化 WhatsApp
- 适用于纯飞书环境，无需 WhatsApp 认证
- `channels` 数组中仅有一个 FeishuChannel 实例

**多渠道并行模式**（默认）：
- WhatsApp 和 Feishu 同时运行，共享同一套编排器、队列、IPC 系统
- 通过 JID 前缀（`fs:` vs `@g.us`/`@s.whatsapp.net`）自动路由到正确 Channel
- 每个 Channel 独立连接、独立断开，互不干扰

对应的初始化逻辑位于 `src/index.ts`：

```typescript
// 多渠道并行：先启动 WhatsApp（除非 FEISHU_ONLY）
if (!FEISHU_ONLY) {
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();
}

// 飞书渠道：有完整配置时启动
if (FEISHU_APP_ID && FEISHU_APP_SECRET && FEISHU_VERIFICATION_TOKEN) {
  const feishu = new FeishuChannel(...);
  channels.push(feishu);
  await feishu.connect();
}
```

---

## 二、核心模块与代码逻辑

### 2.1 Channel 抽象层

所有消息渠道实现统一的 `Channel` 接口（`src/types.ts`），保证编排器与具体渠道解耦：

```typescript
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  sendImage?(jid: string, image: OutboundImage): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;     // JID 归属判定
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
}
```

**JID 命名规范** — 每个渠道使用独有前缀，使得 `findChannel()` 可通过前缀匹配自动路由：

| 渠道 | JID 格式 | 示例 |
|------|---------|------|
| 飞书 | `fs:{chat_id}` | `fs:oc_v4dgef7...` |
| WhatsApp 群组 | `{id}@g.us` | `120363...@g.us` |
| WhatsApp 私聊 | `{id}@s.whatsapp.net` | `86138...@s.whatsapp.net` |

路由函数位于 `src/router.ts`，极为简洁：

```typescript
export function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
```

### 2.2 飞书 Channel 实现

`src/channels/feishu.ts` 中的 `FeishuChannel` 类是飞书集成的核心，实现了完整的 `Channel` 接口。

#### 飞书应用配置

**环境变量**（`src/config.ts`）：

| 变量 | 用途 |
|------|------|
| `FEISHU_APP_ID` | 飞书自建应用 App ID |
| `FEISHU_APP_SECRET` | 飞书自建应用 App Secret |
| `FEISHU_VERIFICATION_TOKEN` | 事件订阅验证令牌 |
| `FEISHU_ONLY` | 设为 `true` 时仅启动飞书渠道 |

**飞书开放平台权限**：

| 权限 Scope | 用途 |
|------------|------|
| `im:message` | 读取和发送消息 |
| `im:message.group_at_msg` | 接收群组中的 @提及消息 |
| `im:chat` | 获取群组信息（名称等） |

**事件订阅**：`im.message.receive_v1`（接收消息事件）

#### 连接建立

`connect()` 方法完成三步初始化：

```
1. 创建 lark.Client（HTTPS API 客户端）
2. 调用 /open-apis/bot/v3/info/ 获取 bot 的 open_id（用于 @提及检测）
3. 创建 lark.WSClient 并启动 WebSocket 长连接
   └─ 注册 EventDispatcher 监听 im.message.receive_v1 事件
```

关键代码：

```typescript
this.client = new lark.Client({
  appId: this.appId,
  appSecret: this.appSecret,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
});

await this.fetchBotOpenId();   // GET /open-apis/bot/v3/info/

const eventDispatcher = new lark.EventDispatcher({
  verificationToken: this.verificationToken,
}).register({
  'im.message.receive_v1': (data) => this.handleMessage(data),
});

this.wsClient = new lark.WSClient({ appId, appSecret });
await this.wsClient.start({ eventDispatcher });
```

WebSocket 连接由 SDK 内部管理，自动处理断线重连和指数退避。

#### 消息接收与处理

`handleMessage()` 是入站消息的核心处理函数，处理流程如下：

```
收到 im.message.receive_v1 事件
  │
  ├─ 过滤 bot 消息（sender_type === 'app'）→ 丢弃
  │
  ├─ 构建 chatJid = "fs:{chat_id}"
  │
  ├─ 并行解析发送者名称 + 群组名称
  │   ├─ resolveUserName(open_id) → 带缓存的用户名查询
  │   └─ resolveChatName(chat_id) → 带缓存的群名查询
  │
  ├─ 存储聊天元数据 → onChatMetadata(chatJid, ..., 'feishu', isGroup)
  │
  ├─ 自动注册（首次消息时）
  │   └─ 按 chat_type 生成 folder: "feishu-group-{id}" 或 "feishu-dm-{id}"
  │
  ├─ 按 message_type 分支处理：
  │   ├─ text:
  │   │   ├─ 解析 @提及占位符（@_user_1 等）→ 替换为真实用户名
  │   │   ├─ 检测 bot 是否被 @提及 → 若是，注入触发模式前缀
  │   │   └─ 记录 recentMentions（用于图片宽限期）
  │   │
  │   ├─ image:
  │   │   ├─ 调用 im.messageResource.get 下载原图
  │   │   ├─ 保存到 groups/{folder}/inbox/feishu/{timestamp}-{id}.{ext}
  │   │   ├─ 生成容器路径 /workspace/group/inbox/feishu/{filename}
  │   │   └─ 检查 60s 宽限期（图片紧跟 @提及视为触发）
  │   │
  │   └─ 其他类型 → 跳过（记录 debug 日志）
  │
  └─ 调用 opts.onMessage(chatJid, NewMessage) → 存入 SQLite
```

#### @提及检测与触发机制

飞书群组中的触发行为通过 `resolveMentions()` 实现：

```typescript
private resolveMentions(text: string, mentions: FeishuMention[]) {
  let botMentioned = false;
  let resolved = text;

  for (const m of mentions) {
    // 优先通过 open_id 匹配，降级为名称匹配
    const isBotMention = this.botOpenId
      ? m.id.open_id === this.botOpenId
      : m.name.toLowerCase() === ASSISTANT_NAME.toLowerCase();

    if (isBotMention) {
      botMentioned = true;
      resolved = resolved.replace(m.key, '').trim();  // 移除 bot 占位符
    } else {
      resolved = resolved.replace(m.key, `@${m.name}`); // 替换为用户名
    }
  }
  return { text: resolved, botMentioned };
}
```

触发规则总结：

| 场景 | 触发条件 |
|------|---------|
| 私聊 (DM) | 无需触发，所有消息直接处理 |
| 群聊 (main 组) | 无需触发（`requiresTrigger: false`） |
| 群聊 (非 main 组) | 需要 `@机器人` 触发 |
| 图片 + @提及 | 飞书不支持图片和 @提及在同一消息中，60 秒宽限期内的图片视为已触发 |

宽限期通过 `recentMentions` Map 实现，以 `{chatJid}:{senderOpenId}` 为 key 记录最近一次 @提及的时间戳。

#### 消息发送

**文本消息**：

```typescript
async sendMessage(jid: string, text: string) {
  const chatId = jid.replace('fs:', '');
  await this.client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
}
```

**图片消息**（两步：上传 → 发送）：

```
1. 读取图片内容（本地路径 或 URL，限制 10MB）
2. 调用 im.image.create 上传获得 image_key
3. 调用 im.message.create 发送图片消息
4. 若有 caption，追加发送一条文本消息
```

### 2.3 编排器

`src/index.ts` 是系统核心，负责状态管理、消息循环和容器调度。

#### 状态管理

编排器维护以下运行时状态，全部持久化到 SQLite：

| 状态 | 存储 | 说明 |
|------|------|------|
| `lastTimestamp` | `router_state` 表 | 全局消息扫描游标 |
| `lastAgentTimestamp` | `router_state` 表 (JSON) | 每群组的 Agent 处理游标 |
| `sessions` | `sessions` 表 | 每群组的 Claude 会话 ID |
| `registeredGroups` | `registered_groups` 表 | 已注册群组配置 |

#### 消息循环（`startMessageLoop`）

以固定间隔（`POLL_INTERVAL`）轮询 SQLite 中的新消息：

```
while (true) {
  1. getNewMessages(jids, lastTimestamp) → 获取所有已注册群组的新消息
  2. 按 chat_jid 分组去重
  3. 对每个群组：
     a. findChannel(channels, chatJid) → 定位渠道
     b. 触发检查：非 main 群组 + 群聊 + requiresTrigger → 需要 TRIGGER_PATTERN
     c. getMessagesSince(lastAgentTimestamp) → 拉取完整上下文（含非触发消息）
     d. 检查是否有活跃容器：
        ├─ 有 → queue.sendMessage() 管道输入到现有容器
        └─ 无 → queue.enqueueMessageCheck() 排队启动新容器
  4. sleep(POLL_INTERVAL)
}
```

#### 消息处理（`processGroupMessages`）

被 GroupQueue 回调执行，处理单个群组的待处理消息：

```
1. getMessagesSince(chatJid, lastAgentTimestamp) → 获取自上次处理以来的消息
2. 触发检查（非 main 群聊需要触发词）
3. formatMessages() → 格式化为 XML
4. 推进游标 + 保存（提前推进防止重复处理）
5. channel.setTyping(true) → 显示"正在输入"
6. runAgent() → 启动容器执行
   └─ 流式回调：每个输出片段实时发送到飞书
7. 错误回滚：若失败且未向用户发送过内容，回退游标
```

### 2.4 消息队列

`src/group-queue.ts` 中的 `GroupQueue` 实现了群组级别的并发控制。

#### 群组状态机

每个群组维护独立的 `GroupState`：

```
                    enqueueMessageCheck()
                           │
         ┌─────────────────▼─────────────────┐
         │         是否有活跃容器？              │
         │                                    │
    ┌────┴─── 是                    否 ───────┴────┐
    │                                              │
    │  pendingMessages = true            是否达到并发上限？
    │  (等待当前容器完成)                      │
    │                                 ┌────┴────┐
    │                              是 │         │ 否
    │                                 │         │
    │                       加入 waitingGroups  runForGroup()
    │                                           │
    │                                    ┌──────▼──────┐
    │                                    │  active=true │
    │                                    │  启动容器     │
    │                                    └──────┬──────┘
    │                                           │
    │                                    processMessagesFn()
    │                                           │
    │                                    ┌──────▼──────┐
    │                                    │ 容器完成      │
    │                                    │ active=false │
    │                                    └──────┬──────┘
    │                                           │
    └───────────────────────────►  drainGroup()
                                        │
                              ┌─────────┴──────────┐
                              │                    │
                        有 pendingTasks?      有 pendingMessages?
                              │                    │
                         runTask()          runForGroup('drain')
```

#### 关键特性

- **并发限制**：`MAX_CONCURRENT_CONTAINERS` 控制全局最大容器数
- **消息管道**：活跃容器通过 IPC input 文件接收后续消息，无需重启容器
- **优先级**：任务（scheduled task）优先于普通消息
- **指数退避重试**：失败时按 5s × 2^n 递增延迟，最多 5 次
- **空闲检测**：`notifyIdle()` 标记容器空闲，若有待执行任务则关闭当前容器

### 2.5 容器运行器

`src/container-runner.ts` 负责容器的创建、挂载配置和输出解析。

#### Volume 挂载策略

```typescript
function buildVolumeMounts(group, isMain): VolumeMount[] {
  // 所有群组都有：
  // - /workspace/group  ← groups/{folder}/  (rw) 群组工作目录
  // - /workspace/ipc    ← data/ipc/{folder}/ (rw) IPC 通道
  // - /home/node/.claude ← data/sessions/{folder}/.claude/ (rw) 会话
  // - /app/src          ← agent-runner-src/ (rw) 可定制的 Agent 源码

  // 非 main 群组额外：
  // - /workspace/global ← groups/global/ (ro) 全局记忆

  // main 群组额外：
  // - /workspace/project ← 项目根目录 (ro) 项目代码
}
```

每个群组的 IPC 目录下有三个子目录：

| 目录 | 用途 | 方向 |
|------|------|------|
| `messages/` | 容器发出的消息/图片 | 容器 → 主进程 |
| `tasks/` | 容器发出的任务指令 | 容器 → 主进程 |
| `input/` | 主进程推送的后续消息 | 主进程 → 容器 |

#### 容器生命周期

```
spawn(docker, ['run', '-i', '--rm', ...mounts, image])
  │
  ├─ stdin.write(JSON.stringify(input))  ← prompt + sessionId + secrets
  ├─ stdin.end()
  │
  ├─ stdout.on('data') → 流式解析 OUTPUT_MARKER 对
  │   └─ 每个完整 JSON 片段 → onOutput(parsed) → sendMessage → 飞书
  │
  ├─ stderr.on('data') → debug 日志（不重置超时）
  │
  ├─ timeout → 超时处理
  │   ├─ 已有输出 → 视为空闲清理（success）
  │   └─ 无输出 → 报错（error）
  │
  └─ close → 最终状态处理 + 日志写入
```

### 2.6 容器内 MCP Server

`container/agent-runner/src/ipc-mcp-stdio.ts` 是运行在容器内部的 MCP 服务器，为 Claude Agent 提供与外部世界交互的工具集。

#### 工具清单

| 工具 | 功能 | IPC 目录 |
|------|------|---------|
| `send_message` | 实时发送文本消息到当前聊天 | `messages/` |
| `send_image` | 发送图片（本地路径或 URL） | `messages/` |
| `schedule_task` | 创建定时/周期任务 | `tasks/` |
| `list_tasks` | 列出已调度的任务 | 读取 `current_tasks.json` |
| `pause_task` | 暂停任务 | `tasks/` |
| `resume_task` | 恢复任务 | `tasks/` |
| `cancel_task` | 取消任务 | `tasks/` |
| `register_group` | 注册新群组（仅 main） | `tasks/` |

#### IPC 文件写入

所有工具通过原子写入（tmp → rename）将 JSON 文件写入 IPC 目录：

```typescript
function writeIpcFile(dir: string, data: object): string {
  const filename = `${Date.now()}-${random}.json`;
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);  // 原子操作，防止读到半写文件
  return filename;
}
```

#### 图片路径暂存

容器内可能生成图片在非共享目录（如 `/tmp`），`stageImagePathForHost()` 负责将其复制到主机可见的路径：

```
容器内路径
  │
  ├─ /workspace/group/... → 直接使用（主机可解析）
  ├─ /workspace/global/... → 直接使用
  ├─ /workspace/project/... → 直接使用
  ├─ /workspace/extra/... → 直接使用
  │
  └─ 其他路径（如 /tmp/img.png）
      └─ 复制到 /workspace/group/.nanoclaw-ipc-images/ 或
         /workspace/ipc/messages/.nanoclaw-ipc-images/
```

### 2.7 IPC 守护

`src/ipc.ts` 中的 `startIpcWatcher()` 以固定间隔（`IPC_POLL_INTERVAL`）轮询所有群组的 IPC 目录。

#### 处理流程

```
每个 IPC 轮询周期：
  for each groupFolder in data/ipc/:
    │
    ├─ 扫描 messages/ 目录下的 *.json 文件
    │   for each file:
    │     1. 解析 JSON → 提取 chatJid
    │     2. 权限校验: isAuthorizedTarget(sourceGroup, isMain, chatJid)
    │        └─ 非 main 只能发给自己的群组
    │     3. 按 type 分发:
    │        ├─ "message" → deps.sendMessage(chatJid, text)
    │        │               └─ findChannel → FeishuChannel.sendMessage
    │        └─ "image"  → resolveIpcImagePath() → deps.sendImage(chatJid, image)
    │                       └─ findChannel → FeishuChannel.sendImage
    │     4. 成功 → 删除文件；失败 → 移入 errors/
    │
    └─ 扫描 tasks/ 目录下的 *.json 文件
        for each file:
          processTaskIpc(data, sourceGroup, isMain)
          └─ schedule_task / pause_task / resume_task / cancel_task / register_group
```

#### 图片路径安全转换

`resolveIpcImagePath()` 将容器内路径转换为宿主机路径，并防止路径穿越：

| 容器路径前缀 | 转换规则 |
|-------------|---------|
| `/workspace/group/...` | → `groups/{folder}/...` |
| `/workspace/global/...` | → `groups/global/...` |
| `/workspace/project/...` | → 项目根目录（仅 main 组） |
| `/workspace/extra/...` | → 根据 `additionalMounts` 配置解析 |
| 相对路径 | → 相对于群组目录解析 |
| 其他绝对路径 | → **拒绝**（安全保护） |

每次转换后都通过 `ensureWithinBase()` 验证结果路径不会逃逸出基准目录。

### 2.8 数据库

`src/db.ts` 使用 `better-sqlite3` 提供同步、嵌入式的持久化存储。

#### 表结构

```
chats
├─ jid (PK)              -- "fs:oc_xxx" 或 "xxx@g.us"
├─ name                   -- 聊天名称
├─ last_message_time      -- 最后消息时间
├─ channel                -- "feishu" / "whatsapp" / "telegram"
└─ is_group               -- 0=私聊, 1=群聊

messages
├─ id + chat_jid (PK)     -- 消息 ID + 聊天 JID
├─ sender                 -- 发送者标识（open_id 等）
├─ sender_name            -- 发送者显示名
├─ content                -- 消息文本内容
├─ timestamp              -- ISO 时间戳
├─ is_from_me             -- 是否为自己发送
└─ is_bot_message         -- 是否为机器人消息（过滤用）

registered_groups
├─ jid (PK)               -- "fs:oc_xxx"
├─ name                   -- 群组显示名
├─ folder (UNIQUE)        -- 文件系统目录名
├─ trigger_pattern        -- "@Andy"
├─ added_at               -- 注册时间
├─ container_config       -- JSON 容器配置
└─ requires_trigger       -- 是否需要触发词

sessions
├─ group_folder (PK)      -- 群组目录名
└─ session_id             -- Claude 会话 ID

router_state
├─ key (PK)               -- "last_timestamp" / "last_agent_timestamp"
└─ value                  -- 状态值

scheduled_tasks / task_run_logs  -- 定时任务及运行记录
```

飞书聊天在存储时标记 `channel='feishu'`，群组标记 `is_group=1`，这些值由 `FeishuChannel.handleMessage()` 中的 `onChatMetadata()` 回调设定。

### 2.9 消息格式化与路由

`src/router.ts` 提供统一的消息格式化和路由功能，对所有渠道通用。

#### 入站格式化

`formatMessages()` 将消息数组转换为 XML 格式供 Claude Agent 消费：

```xml
<messages>
<message sender="张三" time="2026-03-09T10:30:00.000Z">你好，帮我查一下明天天气</message>
<message sender="李四" time="2026-03-09T10:30:15.000Z">@Andy 也帮我查一下</message>
</messages>
```

#### 出站过滤

`formatOutbound()` / `stripInternalTags()` 从 Agent 输出中剥离 `<internal>...</internal>` 标签，这些标签用于 Agent 的内部推理，不应发送给用户。

---

## 三、数据流向

### 3.1 入站消息流（飞书用户 → Claude Agent）

```
飞书用户发送消息
  │
  ▼
飞书服务器 ──WebSocket──▶ WSClient (SDK 自动维护长连接)
  │
  ▼
EventDispatcher 分发 im.message.receive_v1 事件
  │
  ▼
FeishuChannel.handleMessage(data)
  │
  ├─ sender_type === 'app' → 丢弃（过滤 bot 消息）
  │
  ├─ 并行: resolveUserName() + resolveChatName()
  │
  ├─ onChatMetadata() ──▶ SQLite chats 表（channel='feishu'）
  │
  ├─ 自动注册（首次消息）──▶ SQLite registered_groups 表
  │
  ├─ [text] 解析 @提及 → 注入触发前缀
  ├─ [image] 下载图片 → groups/{folder}/inbox/feishu/ → 生成容器路径
  │
  └─ onMessage(chatJid, NewMessage) ──▶ SQLite messages 表
       │
       ▼
  startMessageLoop() 轮询检测到新消息
       │
       ├─ 触发检查（非 main 群聊需要 @机器人）
       │
       ├─ [活跃容器存在]
       │   └─ queue.sendMessage() → 写入 data/ipc/{folder}/input/*.json
       │       → 容器内 Agent Runner 读取 → Claude 继续对话
       │
       └─ [无活跃容器]
           └─ queue.enqueueMessageCheck()
               → processGroupMessages()
                 → getMessagesSince() 获取完整上下文
                 → formatMessages() → XML
                 → runContainerAgent()
                   → docker run -i --rm ... (传入 prompt via stdin)
                     → Claude Agent SDK 处理请求
```

### 3.2 出站消息流（Claude Agent → 飞书用户）

Agent 通过 MCP 工具主动发送消息（如进度更新、多步骤回复）：

```
Claude Agent 调用 MCP send_message / send_image 工具
  │
  ▼
ipc-mcp-stdio.ts writeIpcFile()
  │
  ├─ [send_message] 写入 /workspace/ipc/messages/{ts}.json
  │   { type: "message", chatJid: "fs:oc_xxx", text: "..." }
  │
  └─ [send_image] 写入 /workspace/ipc/messages/{ts}.json
      ├─ 容器可见路径 → stageImagePathForHost() 转换
      └─ { type: "image", chatJid, imagePath / imageUrl, caption }
          │
          ▼
     主进程 IPC Watcher 轮询 (IPC_POLL_INTERVAL)
          │
          ├─ 读取 JSON → 提取 chatJid
          ├─ 权限校验 → isAuthorizedTarget()
          ├─ findChannel(channels, "fs:oc_xxx") → FeishuChannel
          │
          ├─ [文本] FeishuChannel.sendMessage()
          │   └─ client.im.message.create({ msg_type: 'text', ... })
          │       → 飞书 Open API → 飞书用户
          │
          └─ [图片] FeishuChannel.sendImage()
              ├─ resolveIpcImagePath() → 宿主机路径
              ├─ readImageBuffer → client.im.image.create() 上传
              ├─ client.im.message.create({ msg_type: 'image', ... })
              └─ [有 caption] 追加 sendMessage()
                  → 飞书 Open API → 飞书用户
```

### 3.3 流式响应流（Agent 实时输出 → 飞书用户）

Agent 的直接输出（非 MCP 工具调用）通过 stdout 流式传输：

```
Claude Agent SDK 产生 turn 结果
  │
  ▼
Agent Runner 包装为 JSON 并用 MARKER 标记
  stdout.write(OUTPUT_START_MARKER + JSON.stringify(output) + OUTPUT_END_MARKER)
  │
  ▼
container-runner.ts stdout.on('data') 实时解析
  │
  ├─ 在 parseBuffer 中查找完整的 MARKER 对
  ├─ JSON.parse(jsonStr) → ContainerOutput
  │
  ├─ output.newSessionId → 更新 sessions
  ├─ output.result → stripInternalTags → 非空文本
  │   │
  │   ▼
  │   onOutput callback → channel.sendMessage(chatJid, text)
  │   └─ FeishuChannel.sendMessage() → 飞书 Open API → 飞书用户
  │
  ├─ output.status === 'success' → queue.notifyIdle()
  └─ 重置超时计时器（有活动 = 不超时）
```

两条出站通道的区别：

| 特性 | MCP 工具通道 (3.2) | 流式 stdout 通道 (3.3) |
|------|-------------------|----------------------|
| 触发方式 | Agent 主动调用 `send_message` | Agent turn 完成时自动输出 |
| 传输机制 | IPC 文件 → 轮询读取 | stdout 流 → 实时解析 |
| 延迟 | 受 `IPC_POLL_INTERVAL` 影响 | 近实时 |
| 适用场景 | 进度更新、多条消息、图片 | 最终回复 |

---

## 四、安全与隔离设计

### 4.1 容器文件系统隔离

每个群组运行在独立的 Docker 容器中，通过 Volume 挂载实现文件系统隔离：

- **群组隔离**：群组 A 无法访问群组 B 的文件（各自挂载不同的 `groups/{folder}/`）
- **只读保护**：非 main 群组只能以只读方式访问全局目录（`groups/global/`）
- **项目代码保护**：即使 main 群组，项目代码也以只读方式挂载（`/workspace/project`），防止 Agent 修改宿主机应用代码

### 4.2 IPC 权限校验

IPC 守护在处理每条消息时执行身份验证：

```typescript
function isAuthorizedTarget(sourceGroup, isMain, targetJid, registeredGroups) {
  const targetGroup = registeredGroups[targetJid];
  // main 组可以发给任何群组；其他组只能发给自己
  return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
}
```

权限矩阵：

| 操作 | main 群组 | 非 main 群组 |
|------|----------|-------------|
| 发消息给自己 | 允许 | 允许 |
| 发消息给其他群组 | 允许 | **拒绝** |
| 注册新群组 | 允许 | **拒绝** |
| 调度其他群组任务 | 允许 | **拒绝** |
| 刷新群组元数据 | 允许 | **拒绝** |

### 4.3 图片路径安全

`resolveIpcImagePath()` 使用白名单 + 路径穿越检测双重保护：

1. **白名单前缀**：只允许 `/workspace/group`、`/workspace/global`、`/workspace/project`（仅 main）、`/workspace/extra`
2. **路径穿越检测**：`ensureWithinBase()` 验证解析后的路径不会通过 `../` 逃逸出基准目录
3. **非白名单绝对路径一律拒绝**

### 4.4 Secrets 安全传递

敏感凭证（`CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_API_KEY`）仅通过容器 stdin 传递，处理后立即删除引用：

```typescript
input.secrets = readSecrets();
container.stdin.write(JSON.stringify(input));
container.stdin.end();
delete input.secrets;  // 不出现在日志中
```

凭证从不写入磁盘文件、不通过环境变量传递、不出现在容器参数中。

---

## 五、Skill 自动化接入机制

NanoClaw 采用 Skill 引擎实现飞书渠道的自动化接入，使得智能体（Agent）可以通过交互式流程自主完成代码变更、环境配置和群组注册，无需人工编辑代码。

### 5.1 Skill 引擎概述

每个 Skill 由两个核心文件组成：

**`manifest.yaml`** — 声明式描述代码变更：

```yaml
skill: feishu
version: 1.0.0
description: "Feishu (Lark) Bot integration"
core_version: 0.1.0
adds:                              # 新增文件
  - src/channels/feishu.ts
  - src/channels/feishu.test.ts
modifies:                          # 三向合并修改
  - src/index.ts
  - src/config.ts
  - src/routing.test.ts
structured:
  npm_dependencies:                # 自动安装依赖
    "@larksuiteoapi/node-sdk": "^1.30.0"
  env_additions:                   # 新增环境变量
    - FEISHU_APP_ID
    - FEISHU_APP_SECRET
    - FEISHU_VERIFICATION_TOKEN
    - FEISHU_ONLY
conflicts: []                      # 与其他 Skill 无冲突
depends: []                        # 无前置依赖
test: "npx vitest run src/channels/feishu.test.ts"
```

**`SKILL.md`** — 面向智能体的交互式操作手册，指导 Agent 完成全部接入流程。

### 5.2 五阶段自动化流程

```
Phase 1: Pre-flight (预检)
  │
  ├─ 读取 .nanoclaw/state.yaml → 检查 feishu 是否已在 applied_skills 中
  │   ├─ 已应用 → 跳到 Phase 3
  │   └─ 未应用 → 继续
  │
  └─ 向用户提问（AskUserQuestion）：
      ├─ 飞书替换 WhatsApp 还是并行运行？
      └─ 是否已有飞书应用？（若有则收集凭证）
          │
          ▼
Phase 2: Apply (代码变更)
  │
  ├─ 初始化 Skill 系统（如需）：npx tsx scripts/apply-skill.ts --init
  │
  ├─ 执行 Skill：npx tsx scripts/apply-skill.ts .claude/skills/add-feishu
  │   │
  │   ├─ 新增 src/channels/feishu.ts（FeishuChannel 完整实现）
  │   ├─ 新增 src/channels/feishu.test.ts（单元测试）
  │   ├─ 三向合并 src/index.ts（多渠道支持、findChannel 路由）
  │   ├─ 三向合并 src/config.ts（飞书配置导出）
  │   ├─ 三向合并 src/routing.test.ts（路由测试更新）
  │   ├─ 安装 @larksuiteoapi/node-sdk 依赖
  │   ├─ 更新 .env.example
  │   └─ 记录到 .nanoclaw/state.yaml
  │
  └─ 验证：npm test && npm run build
      │
      ▼
Phase 3: Setup (配置)
  │
  ├─ [无飞书应用] 引导用户在飞书开放平台创建应用：
  │   ├─ 创建自建应用
  │   ├─ 配置权限：im:message, im:message.group_at_msg, im:chat
  │   ├─ 订阅事件：im.message.receive_v1
  │   └─ 获取 App ID / App Secret / Verification Token
  │
  ├─ 写入 .env（FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_VERIFICATION_TOKEN）
  ├─ [替换模式] 写入 FEISHU_ONLY=true
  ├─ 同步到容器环境：cp .env data/env/env
  │
  └─ 构建并重启：npm run build && systemctl --user restart nanoclaw
      │
      ▼
Phase 4: Registration (注册)
  │
  ├─ 引导用户获取 Chat ID：
  │   ├─ 将 bot 添加到群组或私聊
  │   └─ 发送消息获取 chat_id
  │
  └─ 注册群组到系统：
      ├─ [主聊天] folder="main", requiresTrigger=false
      └─ [附加聊天] folder="feishu-group-xxx", requiresTrigger=true
          │
          ▼
Phase 5: Verify (验证)
  │
  ├─ 指导用户发送测试消息
  │   ├─ 主聊天 → 任意消息
  │   └─ 非主聊天 → @机器人 + 消息
  │
  └─ 检查日志排查问题：tail -f logs/nanoclaw.log
```

### 5.3 关键设计理念

**代码变更与配置分离**：Phase 2（代码变更）通过 Skill 引擎确定性执行，不依赖用户的飞书凭证；Phase 3（配置）纯粹处理运行时环境，与代码无关。这意味着代码变更可以提前完成并提交到版本控制，而凭证配置在部署时完成。

**三向合并保留定制**：对于需要修改的文件（`index.ts`、`config.ts`），Skill 引擎使用三向合并（base → skill patch → current file），确保用户已有的自定义修改不被覆盖。若出现冲突，Agent 可读取 `*.intent.md` 文件理解变更意图后手动解决。

**Skill 可叠加**：`manifest.yaml` 中的 `conflicts` 和 `depends` 字段声明了 Skill 间的关系。飞书 Skill 无冲突且无前置依赖（`conflicts: []`, `depends: []`），可与 Telegram、Slack 等其他渠道 Skill 自由组合。

**幂等性**：Phase 1 的预检机制（检查 `state.yaml`）确保已应用的 Skill 不会重复执行代码变更，直接跳到配置阶段。
