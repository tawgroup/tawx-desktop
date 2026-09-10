import type { Attachment, Chat, CoworkTask, Message, Settings } from '../types';

const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|auth(?:orization)?|password|passwd|pwd|secret(?:[_-]?access[_-]?key)?|credential|cookie|private[_-]?key)$/i;
const SECRET_ATTACHMENT_NAME = /(?:^|[._-])(?:env|secrets?|credentials?|tokens?|api[._-]?keys?|private[._-]?keys?|id[._-]?(?:rsa|dsa|ecdsa|ed25519))(?:[._-]|$)|^\.?(?:npmrc|pypirc|netrc)$/i;
const REDACTED = '[REDACTED]';
const REDACTED_ATTACHMENT = '[REDACTED: sensitive attachment content]';

const QUOTED_ASSIGNMENT = /((?:[A-Z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|auth(?:orization)?|password|passwd|pwd|secret(?:[_-]?access[_-]?key)?|credential|cookie|private[_-]?key)["']?\s*[:=]\s*)(["'])(.*?)\2/gi;
const UNQUOTED_ASSIGNMENT = /((?:[A-Z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|auth(?:orization)?|password|passwd|pwd|secret(?:[_-]?access[_-]?key)?|credential|cookie|private[_-]?key)\s*[:=]\s*)((?:(?:Bearer|Basic)\s+)?[^\s,;}\]]+)/gi;
const AUTHORIZATION = /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9+/_.=:-]+/gi;
const URL_CREDENTIALS = /(https?:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
const CREDENTIAL_SHAPES = /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;

/** Redacts common credential forms while leaving ordinary conversation text intact. */
export function redactSecrets(text: string): string {
  return text
    .replace(PRIVATE_KEY, REDACTED)
    .replace(QUOTED_ASSIGNMENT, (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`)
    .replace(UNQUOTED_ASSIGNMENT, `$1${REDACTED}`)
    .replace(AUTHORIZATION, `$1${REDACTED}`)
    .replace(URL_CREDENTIALS, `$1${REDACTED}$2`)
    .replace(CREDENTIAL_SHAPES, REDACTED);
}

function redactAttachment(attachment: Attachment): Attachment {
  const name = redactSecrets(attachment.name);
  if (attachment.kind !== 'text' || attachment.text === undefined) return { ...attachment, name };
  return {
    ...attachment,
    name,
    text: SECRET_ATTACHMENT_NAME.test(attachment.name)
      ? REDACTED_ATTACHMENT
      : redactSecrets(attachment.text),
  };
}

/** Creates a persistence-only clone; the caller's live in-memory message is untouched. */
export function redactMessageForPersistence(message: Message): Message {
  return {
    ...message,
    content: redactSecrets(message.content),
    context: message.context === undefined ? undefined : redactSecrets(message.context),
    reasoning: message.reasoning === undefined ? undefined : redactSecrets(message.reasoning),
    error: message.error === undefined ? undefined : redactSecrets(message.error),
    attachments: message.attachments?.map(redactAttachment),
    visionAnalysis: message.visionAnalysis === undefined
      ? undefined
      : { ...message.visionAnalysis, text: redactSecrets(message.visionAnalysis.text) },
  };
}

/** Creates a persistence-only thread clone while retaining routing metadata. */
export function redactChatForPersistence(chat: Chat): Chat {
  return {
    ...chat,
    title: redactSecrets(chat.title),
    systemPrompt: chat.systemPrompt === undefined ? undefined : redactSecrets(chat.systemPrompt),
  };
}

/** Recursively redacts task audit payloads, diffs, artifacts, and model text. */
export function redactUnknown(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key)) return REDACTED;
    if (value.startsWith('data:image/')) return value;
    return redactSecrets(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactUnknown(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export function redactTaskForPersistence(task: CoworkTask): CoworkTask {
  return redactUnknown(task) as CoworkTask;
}

/** Provider credentials stay in their existing settings store; prompt text does not. */
export function redactSettingsForPersistence(settings: Settings): Settings {
  if (typeof settings.systemPrompt !== 'string') return { ...settings };
  return { ...settings, systemPrompt: redactSecrets(settings.systemPrompt) };
}
