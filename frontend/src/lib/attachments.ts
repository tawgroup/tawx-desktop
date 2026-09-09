import type { Attachment } from '../types';

export const MAX_ATTACHMENTS = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Ten binary MiB expands to about 14M base64 characters, below the desktop per-message ceiling.
export const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_CHARACTERS_PER_FILE = 40_000;
export const MAX_TOTAL_TEXT_CHARACTERS = 80_000;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const IMAGE_MIME_TYPES: Record<string, true> = {
  'image/gif': true,
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
};

const TEXT_MIME_TYPES: Record<string, true> = {
  'application/javascript': true,
  'application/typescript': true,
  'application/json': true,
  'application/ld+json': true,
  'application/sql': true,
  'application/toml': true,
  'application/x-httpd-php': true,
  'application/x-javascript': true,
  'application/x-ndjson': true,
  'application/x-sh': true,
  'application/x-yaml': true,
  'application/xml': true,
  'application/yaml': true,
  'image/svg+xml': true,
};

const TEXT_EXTENSIONS: Record<string, true> = {
  c: true, cc: true, cfg: true, conf: true, cpp: true, cs: true, css: true, csv: true, cxx: true, diff: true,
  env: true, go: true, graphql: true, h: true, hpp: true, htm: true, html: true, ini: true, java: true, js: true,
  json: true, jsonl: true, jsx: true, kt: true, kts: true, less: true, log: true, lua: true, md: true, mdx: true,
  mjs: true, mts: true, php: true, pl: true, properties: true, proto: true, py: true, rb: true, rs: true, rst: true,
  sass: true, scala: true, scss: true, sh: true, sql: true, svelte: true, swift: true, toml: true, ts: true,
  tsx: true, txt: true, vue: true, xml: true, yaml: true, yml: true, zsh: true,
};

export const ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,text/*,.c,.cc,.cfg,.conf,.cpp,.cs,.css,.csv,.cxx,.diff,.env,.go,.graphql,.h,.hpp,.htm,.html,.ini,.java,.js,.json,.jsonl,.jsx,.kt,.kts,.less,.log,.lua,.md,.mdx,.mjs,.mts,.php,.pl,.properties,.proto,.py,.rb,.rs,.rst,.sass,.scala,.scss,.sh,.sql,.svelte,.swift,.toml,.ts,.tsx,.txt,.vue,.xml,.yaml,.yml,.zsh';

export type AttachmentClassification = { kind: 'image' | 'text'; mimeType: string; pdf: boolean };

export interface AttachmentFileInfo {
  name: string;
  type: string;
  size: number;
}

export interface PreparedAttachments {
  attachments: Attachment[];
  errors: string[];
}

export function classifyAttachment(file: AttachmentFileInfo): AttachmentClassification | null {
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  const declaredType = file.type.toLowerCase().split(';', 1)[0];
  const canInferFromExtension = !declaredType || declaredType === 'application/octet-stream';
  const imageType = IMAGE_MIME_TYPES[declaredType]
    ? declaredType
    : canInferFromExtension
      ? IMAGE_MIME_BY_EXTENSION[extension]
      : undefined;
  if (imageType) {
    return { kind: 'image', mimeType: imageType, pdf: false };
  }
  if (declaredType === 'application/pdf' || (canInferFromExtension && extension === 'pdf')) {
    return { kind: 'text', mimeType: 'application/pdf', pdf: true };
  }
  if (
    declaredType.startsWith('text/')
    || TEXT_MIME_TYPES[declaredType]
    || (canInferFromExtension && TEXT_EXTENSIONS[extension])
  ) {
    return {
      kind: 'text',
      mimeType: declaredType && declaredType !== 'application/octet-stream' ? declaredType : 'text/plain',
      pdf: false,
    };
  }
  return null;
}

export function truncateAttachmentText(text: string, limit: number) {
  return { text: text.slice(0, Math.max(0, limit)), truncated: text.length > limit };
}

export function validateAttachment(file: AttachmentFileInfo, classification: AttachmentClassification | null) {
  if (!classification) {
    return `${file.name}: unsupported file type. Attach PNG, JPEG, GIF, WebP, PDF, or a readable text/code file.`;
  }
  const maximum = classification.kind === 'image'
    ? MAX_IMAGE_BYTES
    : classification.pdf
      ? MAX_PDF_BYTES
      : MAX_TEXT_FILE_BYTES;
  if (file.size > maximum) {
    return `${file.name}: file is too large (maximum ${Math.round(maximum / (1024 * 1024))} MB).`;
  }
  if (file.size === 0) return `${file.name}: empty files cannot be attached.`;
  return null;
}

function readDataUrl(file: File, mimeType: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not be read'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('could not be read'));
        return;
      }
      resolve(reader.result.replace(/^data:[^;]*;/, `data:${mimeType};`));
    };
    reader.readAsDataURL(file);
  });
}

async function prepareOne(file: File, classification: AttachmentClassification, textBudget: number): Promise<Attachment> {
  const common = {
    id: crypto.randomUUID(),
    name: file.name || 'Untitled attachment',
    mimeType: classification.mimeType,
    size: file.size,
  };

  if (classification.kind === 'image') {
    return { ...common, kind: 'image', dataUrl: await readDataUrl(file, classification.mimeType) };
  }

  if (textBudget <= 0) throw new Error('the readable attachment context limit has been reached');
  const limit = Math.min(textBudget, MAX_TEXT_CHARACTERS_PER_FILE);
  if (classification.pdf) {
    // The PDF worker uses Vite's browser-only `?url` loader, which Node's test runner cannot import.
    const { extractPdfText } = await import('./pdfText');
    const extracted = await extractPdfText(file, limit);
    return { ...common, kind: 'text', text: extracted.text, truncated: extracted.truncated };
  }

  const rawText = await file.text();
  if (rawText.includes('\0')) throw new Error('the file appears to contain binary data');
  const bounded = truncateAttachmentText(rawText, limit);
  return { ...common, kind: 'text', ...bounded };
}

/** Convert browser files into the persisted, provider-safe attachment representation. */
export async function prepareAttachments(files: readonly File[], current: readonly Attachment[]): Promise<PreparedAttachments> {
  const attachments: Attachment[] = [];
  const errors: string[] = [];
  let totalBytes = current.reduce((sum, attachment) => sum + attachment.size, 0);
  let totalImageBytes = current.reduce(
    (sum, attachment) => sum + (attachment.kind === 'image' ? attachment.size : 0),
    0,
  );
  let textCharacters = current.reduce((sum, attachment) => sum + (attachment.text?.length ?? 0), 0);

  for (const file of files) {
    if (current.length + attachments.length >= MAX_ATTACHMENTS) {
      errors.push(`You can attach up to ${MAX_ATTACHMENTS} files at once.`);
      break;
    }

    const classification = classifyAttachment(file);
    const error = validateAttachment(file, classification);
    if (error) {
      errors.push(error);
      continue;
    }
    if (!classification) continue;
    if (totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      errors.push(`${file.name}: attachments exceed the ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024))} MB total limit.`);
      continue;
    }
    if (classification.kind === 'image' && totalImageBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
      errors.push(`${file.name}: images exceed the ${Math.round(MAX_TOTAL_IMAGE_BYTES / (1024 * 1024))} MB combined limit.`);
      continue;
    }

    try {
      const attachment = await prepareOne(file, classification, MAX_TOTAL_TEXT_CHARACTERS - textCharacters);
      attachments.push(attachment);
      totalBytes += file.size;
      if (attachment.kind === 'image') totalImageBytes += attachment.size;
      textCharacters += attachment.text?.length ?? 0;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'could not be read';
      errors.push(`${file.name}: ${reason}`);
    }
  }

  return { attachments, errors };
}
