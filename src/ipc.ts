import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { OutboundImage, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendImage: (jid: string, image: OutboundImage) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

function isAuthorizedTarget(
  sourceGroup: string,
  isMain: boolean,
  targetJid: string,
  registeredGroups: Record<string, RegisteredGroup>,
): boolean {
  const targetGroup = registeredGroups[targetJid];
  return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
}

function ensureWithinBase(baseDir: string, targetPath: string): boolean {
  const rel = path.relative(baseDir, targetPath);
  return !(rel.startsWith('..') || path.isAbsolute(rel));
}

function expandHomeDir(inputPath: string): string {
  if (!inputPath.startsWith('~')) return inputPath;
  const home = process.env.HOME || '';
  if (!home) return inputPath;
  if (inputPath === '~') return home;
  if (inputPath.startsWith('~/')) return path.join(home, inputPath.slice(2));
  return inputPath;
}

function resolveExtraMountPath(
  sourceGroup: string,
  containerPath: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | null {
  const rel = containerPath.slice('/workspace/extra/'.length);
  if (!rel) return null;

  const sourceEntry = Object.values(registeredGroups).find(
    (g) => g.folder === sourceGroup,
  );
  const mounts = sourceEntry?.containerConfig?.additionalMounts || [];

  for (const mount of mounts) {
    const mountAlias =
      mount.containerPath || path.basename(expandHomeDir(mount.hostPath));
    if (
      rel !== mountAlias &&
      !rel.startsWith(`${mountAlias}/`)
    ) {
      continue;
    }

    const hostBase = path.resolve(expandHomeDir(mount.hostPath));
    const nested = rel.slice(mountAlias.length).replace(/^\/+/, '');
    const resolved = nested ? path.resolve(hostBase, nested) : hostBase;
    if (ensureWithinBase(hostBase, resolved)) {
      return resolved;
    }
    return null;
  }

  return null;
}

function resolveIpcImagePath(
  sourceGroup: string,
  imagePath: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | null {
  const input = imagePath.trim();
  if (!input) return null;

  const sourceGroupDir = resolveGroupFolderPath(sourceGroup);
  const globalDir = path.resolve(GROUPS_DIR, 'global');

  if (input.startsWith('/workspace/group')) {
    const suffix = input.slice('/workspace/group'.length);
    const resolved = path.resolve(sourceGroupDir, `.${suffix}`);
    return ensureWithinBase(sourceGroupDir, resolved) ? resolved : null;
  }

  if (input.startsWith('/workspace/global')) {
    const suffix = input.slice('/workspace/global'.length);
    const resolved = path.resolve(globalDir, `.${suffix}`);
    return ensureWithinBase(globalDir, resolved) ? resolved : null;
  }

  if (input.startsWith('/workspace/project')) {
    if (sourceGroup !== MAIN_GROUP_FOLDER) return null;
    const suffix = input.slice('/workspace/project'.length);
    const projectRoot = process.cwd();
    const resolved = path.resolve(projectRoot, `.${suffix}`);
    return ensureWithinBase(projectRoot, resolved) ? resolved : null;
  }

  if (input.startsWith('/workspace/extra/')) {
    return resolveExtraMountPath(sourceGroup, input, registeredGroups);
  }

  if (input.startsWith('/workspace/ipc/messages/')) {
    const suffix = input.slice('/workspace/ipc/messages'.length);
    const ipcMessagesDir = path.resolve(DATA_DIR, 'ipc', sourceGroup, 'messages');
    const resolved = path.resolve(ipcMessagesDir, `.${suffix}`);
    return ensureWithinBase(ipcMessagesDir, resolved) ? resolved : null;
  }

  if (path.isAbsolute(input)) {
    return null;
  }

  const resolved = path.resolve(sourceGroupDir, input);
  return ensureWithinBase(sourceGroupDir, resolved) ? resolved : null;
}

function cleanupStagedImageIfNeeded(sourceGroup: string, hostPath: string): void {
  if (!hostPath.includes(`${path.sep}.nanoclaw-ipc-images${path.sep}`)) return;

  const groupDir = resolveGroupFolderPath(sourceGroup);
  const ipcMessagesDir = path.resolve(DATA_DIR, 'ipc', sourceGroup, 'messages');
  const inGroup = ensureWithinBase(groupDir, hostPath);
  const inIpcMessages = ensureWithinBase(ipcMessagesDir, hostPath);
  if (!inGroup && !inIpcMessages) return;

  try {
    fs.unlinkSync(hostPath);
  } catch (err) {
    logger.debug({ sourceGroup, hostPath, err }, 'Failed to delete staged image');
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              const chatJid =
                typeof data.chatJid === 'string' ? data.chatJid : '';

              if (!chatJid) {
                logger.warn({ sourceGroup, file }, 'IPC message missing chatJid');
              } else if (
                !isAuthorizedTarget(
                  sourceGroup,
                  isMain,
                  chatJid,
                  registeredGroups,
                )
              ) {
                logger.warn(
                  { chatJid, sourceGroup },
                  'Unauthorized IPC message attempt blocked',
                );
              } else if (
                data.type === 'message' &&
                typeof data.text === 'string' &&
                data.text.trim().length > 0
              ) {
                await deps.sendMessage(chatJid, data.text);
                logger.info({ chatJid, sourceGroup }, 'IPC message sent');
              } else if (data.type === 'image') {
                const imagePath =
                  typeof data.imagePath === 'string' ? data.imagePath.trim() : '';
                const imageUrl =
                  typeof data.imageUrl === 'string' ? data.imageUrl.trim() : '';
                const hasPath = imagePath.length > 0;
                const hasUrl = imageUrl.length > 0;
                const caption =
                  typeof data.caption === 'string' ? data.caption : undefined;

                if ((hasPath ? 1 : 0) + (hasUrl ? 1 : 0) !== 1) {
                  logger.warn(
                    { chatJid, sourceGroup, file },
                    'Invalid IPC image payload: must include exactly one of imagePath or imageUrl',
                  );
                } else if (hasPath) {
                  const hostPath = resolveIpcImagePath(
                    sourceGroup,
                    imagePath,
                    registeredGroups,
                  );
                  if (!hostPath) {
                    logger.warn(
                      { chatJid, sourceGroup, imagePath },
                      'IPC image path rejected or not resolvable',
                    );
                  } else {
                    try {
                      await deps.sendImage(chatJid, { path: hostPath, caption });
                      logger.info(
                        { chatJid, sourceGroup, imagePath: hostPath },
                        'IPC image sent',
                      );
                    } finally {
                      cleanupStagedImageIfNeeded(sourceGroup, hostPath);
                    }
                  }
                } else {
                  await deps.sendImage(chatJid, { url: imageUrl, caption });
                  logger.info(
                    { chatJid, sourceGroup, imageUrl },
                    'IPC image sent',
                  );
                }
              } else {
                logger.warn(
                  { sourceGroup, file, type: data.type },
                  'Unknown IPC message type',
                );
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
