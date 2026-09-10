import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Chat, CoworkTask, Message, Settings } from '../types';
import { DEFAULT_SETTINGS } from '../types.ts';
import {
  redactChatForPersistence,
  redactMessageForPersistence,
  redactSettingsForPersistence,
  redactTaskForPersistence,
  redactUnknown,
} from './redaction.ts';
import { isProviderRoutable, normalizeProviders } from './providers.ts';

const DB_NAME = 'chatopenapi';
const DB_VERSION = 4;
const SETTINGS_KEY = 'app';

interface ChatDB extends DBSchema {
  chats: {
    key: string;
    value: Chat;
    indexes: { 'by-updated': number };
  };
  messages: {
    key: string;
    value: Message;
    indexes: { 'by-chat': string };
  };
  tasks: {
    key: string;
    value: CoworkTask;
    indexes: { 'by-thread': string; 'by-updated': number };
  };
  settings: {
    key: string;
    value: Settings;
  };
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null;

function getDB(): Promise<IDBPDatabase<ChatDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ChatDB>(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion, _newVersion, transaction) {
        if (!database.objectStoreNames.contains('chats')) {
          const chats = database.createObjectStore('chats', { keyPath: 'id' });
          chats.createIndex('by-updated', 'updatedAt');
        }
        if (!database.objectStoreNames.contains('messages')) {
          const messages = database.createObjectStore('messages', { keyPath: 'id' });
          messages.createIndex('by-chat', 'chatId');
        }
        if (!database.objectStoreNames.contains('settings')) {
          database.createObjectStore('settings');
        }
        if (!database.objectStoreNames.contains('tasks')) {
          const tasks = database.createObjectStore('tasks', { keyPath: 'id' });
          tasks.createIndex('by-thread', 'threadId');
          tasks.createIndex('by-updated', 'updatedAt');
        }
        if (oldVersion < 3) {
          const redactChats = async () => {
            let cursor = await transaction.objectStore('chats').openCursor();
            while (cursor) {
              await cursor.update(redactChatForPersistence(cursor.value));
              cursor = await cursor.continue();
            }
          };
          const redactMessages = async () => {
            let cursor = await transaction.objectStore('messages').openCursor();
            while (cursor) {
              await cursor.update(redactMessageForPersistence(cursor.value));
              cursor = await cursor.continue();
            }
          };
          const redactTasks = async () => {
            let cursor = await transaction.objectStore('tasks').openCursor();
            while (cursor) {
              await cursor.update(redactTaskForPersistence(cursor.value));
              cursor = await cursor.continue();
            }
          };
          const redactSettings = async () => {
            let cursor = await transaction.objectStore('settings').openCursor();
            while (cursor) {
              await cursor.update(redactSettingsForPersistence(cursor.value));
              cursor = await cursor.continue();
            }
          };
          void Promise.all([redactChats(), redactMessages(), redactTasks(), redactSettings()])
            .catch(() => transaction.abort());
        }
        // Web search became a default rather than an opt-in. A stored profile
        // carries the old `false` and loadSettings lets stored win over
        // DEFAULT_SETTINGS, so the flag has to be flipped in place or existing
        // profiles would never see the new default.
        if (oldVersion > 0 && oldVersion < 4) {
          const enableWebSearch = async () => {
            const settings = transaction.objectStore('settings');
            let cursor = await settings.openCursor();
            while (cursor) {
              await cursor.update({ ...cursor.value, webSearch: true });
              cursor = await cursor.continue();
            }
          };
          void enableWebSearch().catch(() => transaction.abort());
        }
      },
    });
  }
  return dbPromise;
}

export async function listChats(): Promise<Chat[]> {
  const database = await getDB();
  const chats = await database.getAllFromIndex('chats', 'by-updated');
  return chats.reverse();
}

export async function saveChat(chat: Chat): Promise<void> {
  const database = await getDB();
  await database.put('chats', redactChatForPersistence(chat));
}

export async function deleteChat(chatId: string): Promise<void> {
  const database = await getDB();
  const tx = database.transaction(['chats', 'messages', 'tasks'], 'readwrite');
  await tx.objectStore('chats').delete(chatId);

  const messageStore = tx.objectStore('messages');
  const messageKeys = await messageStore.index('by-chat').getAllKeys(chatId);
  await Promise.all(messageKeys.map((key) => messageStore.delete(key)));

  const taskStore = tx.objectStore('tasks');
  const taskKeys = await taskStore.index('by-thread').getAllKeys(chatId);
  await Promise.all(taskKeys.map((key) => taskStore.delete(key)));
  await tx.done;
}

export async function listMessages(chatId: string): Promise<Message[]> {
  const database = await getDB();
  const messages = await database.getAllFromIndex('messages', 'by-chat', chatId);
  return messages.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveMessage(message: Message): Promise<void> {
  const database = await getDB();
  await database.put('messages', redactMessageForPersistence(message));
}

export async function deleteMessage(messageId: string): Promise<void> {
  const database = await getDB();
  await database.delete('messages', messageId);
}

/** Removes a message and every message created after it in the same chat. */
export async function deleteMessagesFrom(chatId: string, createdAt: number): Promise<void> {
  const database = await getDB();
  const tx = database.transaction('messages', 'readwrite');
  const store = tx.objectStore('messages');
  const all = await store.index('by-chat').getAll(chatId);
  await Promise.all(all.filter((message) => message.createdAt >= createdAt).map((message) => store.delete(message.id)));
  await tx.done;
}

export async function listTasks(): Promise<CoworkTask[]> {
  const database = await getDB();
  const tasks = await database.getAllFromIndex('tasks', 'by-updated');
  return tasks.reverse();
}

export async function listTasksForThread(threadId: string): Promise<CoworkTask[]> {
  const database = await getDB();
  const tasks = await database.getAllFromIndex('tasks', 'by-thread', threadId);
  return tasks.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadTask(taskId: string): Promise<CoworkTask | undefined> {
  const database = await getDB();
  return database.get('tasks', taskId);
}

export async function saveTask(task: CoworkTask): Promise<void> {
  const database = await getDB();
  await database.put('tasks', redactTaskForPersistence(task));
}

export async function deleteTask(taskId: string): Promise<void> {
  const database = await getDB();
  await database.delete('tasks', taskId);
}

export async function loadSettings(): Promise<Settings> {
  const database = await getDB();
  const stored = await database.get('settings', SETTINGS_KEY);
  if (!stored) {
    return { ...DEFAULT_SETTINGS, coworkEnabledTools: [...DEFAULT_SETTINGS.coworkEnabledTools] };
  }

  const providers = normalizeProviders(stored.providers ?? DEFAULT_SETTINGS.providers);
  const activeProvider = providers.find((provider) => provider.id === stored.activeProviderId && isProviderRoutable(provider))
    ?? providers.find(isProviderRoutable);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    providers,
    activeProviderId: activeProvider?.id ?? '',
    coworkEnabledTools: stored.coworkEnabledTools ?? DEFAULT_SETTINGS.coworkEnabledTools,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const database = await getDB();
  await database.put('settings', redactSettingsForPersistence(settings), SETTINGS_KEY);
}

/** Wipes every store. Used by the "delete all data" action in settings. */
export async function clearAll(): Promise<void> {
  const database = await getDB();
  const tx = database.transaction(['chats', 'messages', 'tasks', 'settings'], 'readwrite');
  await Promise.all([
    tx.objectStore('chats').clear(),
    tx.objectStore('messages').clear(),
    tx.objectStore('tasks').clear(),
    tx.objectStore('settings').clear(),
  ]);
  await tx.done;
}


export async function exportData(): Promise<string> {
  const database = await getDB();
  const [chats, messages, tasks, settings] = await Promise.all([
    database.getAll('chats'),
    database.getAll('messages'),
    database.getAll('tasks'),
    database.get('settings', SETTINGS_KEY),
  ]);
  const safeSettings = settings
    ? { ...settings, providers: settings.providers.map((provider) => ({ ...provider, apiKey: '' })) }
    : null;
  return JSON.stringify(redactUnknown({ version: DB_VERSION, chats, messages, tasks, settings: safeSettings }), null, 2);
}

export async function importData(json: string): Promise<void> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid backup file');
  const data = parsed as { chats?: Chat[]; messages?: Message[]; tasks?: CoworkTask[] };
  const database = await getDB();
  const tx = database.transaction(['chats', 'messages', 'tasks'], 'readwrite');
  for (const chat of data.chats ?? []) await tx.objectStore('chats').put(redactChatForPersistence(chat));
  for (const message of data.messages ?? []) await tx.objectStore('messages').put(redactMessageForPersistence(message));
  for (const task of data.tasks ?? []) await tx.objectStore('tasks').put(redactTaskForPersistence(task));
  await tx.done;
}
