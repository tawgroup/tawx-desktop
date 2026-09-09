import { BrowserWindow } from 'electron';
import type { CapabilityAdapter, CapabilityContext, CapabilityStatus, CapabilityTool } from './capabilities.js';

const MAX_INSPECT_TEXT = 30_000;
const MAX_ELEMENTS = 100;
const MAX_SELECTOR_LENGTH = 500;
const MAX_INPUT_LENGTH = 10_000;
const MAX_BROWSER_SESSIONS = 8;
const BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;
const BROWSER_ACTION_TIMEOUT_MS = 10_000;

export interface BrowserInspection {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  elements: Array<{
    selector: string;
    role: string;
    name: string;
    disabled: boolean;
  }>;
}

export interface BrowserSession {
  navigate(url: string, signal?: AbortSignal): Promise<{ url: string; title: string }>;
  inspect(signal?: AbortSignal): Promise<BrowserInspection>;
  interact(action: BrowserInteraction, signal?: AbortSignal): Promise<BrowserInspection>;
  close(): void;
}

export type BrowserInteraction =
  | { action: 'click'; selector: string }
  | { action: 'type'; selector: string; value: string }
  | { action: 'select'; selector: string; value: string };

export type BrowserSessionFactory = () => BrowserSession;

export class BrowserAdapter implements CapabilityAdapter {
  readonly id = 'browser';
  private readonly sessions = new Map<string, BrowserSession>();
  private lastError: string | null = null;

  constructor(private readonly createSession: BrowserSessionFactory = createElectronBrowserSession) {}

  async status(): Promise<CapabilityStatus> {
    return {
      id: this.id,
      name: 'Browser',
      available: this.lastError === null,
      configured: true,
      detail: this.lastError
        ? `Browser automation is unavailable: ${this.lastError}. Restart the desktop app to retry.`
        : 'Ready. Navigation, inspection, and interaction require explicit approval.',
      toolCount: this.lastError === null ? 3 : 0,
    };
  }

  async tools(): Promise<readonly CapabilityTool[]> {
    if (this.lastError) return [];
    return [this.navigateTool(), this.inspectTool(), this.interactTool()];
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private navigateTool(): CapabilityTool {
    return {
      definition: {
        type: 'function',
        function: {
          name: 'browser_navigate',
          description: 'Open an HTTP or HTTPS page in the isolated desktop browser.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['url'],
            properties: { url: { type: 'string', description: 'Absolute HTTP or HTTPS URL' } },
          },
        },
      },
      risk: 'external',
      alwaysApprove: true,
      approvalDetail: (input) => `Navigate the isolated browser to ${safeDisplayUrl(requiredString(input, 'url'))}`,
      auditInput: (input) => ({ url: safeDisplayUrl(requiredString(input, 'url')) }),
      auditResult: browserAuditSummary,
      invoke: async (input, context) => {
        const url = validateUrl(requiredString(input, 'url'));
        return this.useSession(context.taskId, (session) => session.navigate(url, context.signal));
      },
    };
  }

  private inspectTool(): CapabilityTool {
    return {
      definition: {
        type: 'function',
        function: {
          name: 'browser_inspect',
          description: 'Read bounded visible text and actionable elements from the current browser page.',
          parameters: { type: 'object', additionalProperties: false, properties: {} },
        },
      },
      risk: 'external',
      alwaysApprove: true,
      approvalDetail: () => 'Inspect the current page in the isolated browser',
      auditResult: browserAuditSummary,
      invoke: async (_input, context) => this.useSession(context.taskId, (session) => session.inspect(context.signal)),
    };
  }

  private interactTool(): CapabilityTool {
    return {
      definition: {
        type: 'function',
        function: {
          name: 'browser_interact',
          description: 'Click, type into, or select one element on the current browser page. Arbitrary scripts are not accepted.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'selector'],
            properties: {
              action: { type: 'string', enum: ['click', 'type', 'select'] },
              selector: { type: 'string', description: 'CSS selector returned by browser_inspect' },
              value: { type: 'string', description: 'Text or option value for type/select' },
            },
          },
        },
      },
      risk: 'external',
      alwaysApprove: true,
      approvalDetail: (input) => {
        const action = parseInteraction(input);
        return `${action.action} ${action.selector} in the isolated browser`;
      },
      auditInput: (input) => {
        const action = parseInteraction(input);
        return { action: action.action, selector: action.selector, value: 'value' in action ? '[REDACTED]' : undefined };
      },
      auditResult: browserAuditSummary,
      invoke: async (input, context) => {
        const action = parseInteraction(input);
        return this.useSession(context.taskId, (session) => session.interact(action, context.signal));
      },
    };
  }

  private async useSession<T>(taskId: string, operation: (session: BrowserSession) => Promise<T>): Promise<T> {
    let session = this.sessions.get(taskId);
    if (session) {
      this.sessions.delete(taskId);
      this.sessions.set(taskId, session);
      return operation(session);
    }
    try {
      session = this.createSession();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    if (this.sessions.size >= MAX_BROWSER_SESSIONS) {
      const oldest = this.sessions.entries().next();
      if (!oldest.done) {
        const [oldestTaskId, oldestSession] = oldest.value;
        this.sessions.delete(oldestTaskId);
        oldestSession.close();
      }
    }
    this.sessions.set(taskId, session);
    return operation(session);
  }
}

export function createElectronBrowserSession(): BrowserSession {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `tawx-browser-${crypto.randomUUID()}`,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.on('will-download', (event) => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => {
    try {
      validateUrl(url);
    } catch {
      event.preventDefault();
    }
  });

  return {
    async navigate(url, signal) {
      throwIfAborted(signal);
      try {
        await withBrowserDeadline(window.loadURL(validateUrl(url)), signal, BROWSER_NAVIGATION_TIMEOUT_MS, 'navigation');
      } catch (error) {
        window.webContents.stop();
        throw error;
      }
      throwIfAborted(signal);
      const finalUrl = validateUrl(window.webContents.getURL());
      return { url: finalUrl, title: window.webContents.getTitle().slice(0, 500) };
    },
    async inspect(signal) {
      throwIfAborted(signal);
      const inspection = await withBrowserDeadline<BrowserInspection>(
        window.webContents.executeJavaScript(INSPECT_PAGE_SCRIPT, true),
        signal,
        BROWSER_ACTION_TIMEOUT_MS,
        'inspection',
      );
      throwIfAborted(signal);
      inspection.url = validateUrl(inspection.url);
      return inspection;
    },
    async interact(action, signal) {
      throwIfAborted(signal);
      const serialized = JSON.stringify(action);
      await withBrowserDeadline(
        window.webContents.executeJavaScript(`(${INTERACT_PAGE_SCRIPT})(${serialized})`, true),
        signal,
        BROWSER_ACTION_TIMEOUT_MS,
        'interaction',
      );
      const inspection = await withBrowserDeadline<BrowserInspection>(
        window.webContents.executeJavaScript(INSPECT_PAGE_SCRIPT, true),
        signal,
        BROWSER_ACTION_TIMEOUT_MS,
        'inspection',
      );
      throwIfAborted(signal);
      inspection.url = validateUrl(inspection.url);
      return inspection;
    },
    close() {
      if (!window.isDestroyed()) window.destroy();
    },
  };
}

const INSPECT_PAGE_SCRIPT = `(() => {
  const limit = ${MAX_INSPECT_TEXT};
  const rawText = document.body ? document.body.innerText : '';
  const candidates = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role="button"]')).slice(0, ${MAX_ELEMENTS});
  const selectorFor = (element) => {
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 8) {
      if (current.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(current.id)) {
        parts.unshift('#' + current.id);
        break;
      }
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
      parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')');
      current = parent;
    }
    return parts.join(' > ');
  };
  return {
    url: location.href,
    title: document.title.slice(0, 500),
    text: rawText.slice(0, limit),
    truncated: rawText.length > limit,
    elements: candidates.map((element) => ({
      selector: selectorFor(element),
      role: element.getAttribute('role') || element.tagName.toLowerCase(),
      name: (element.getAttribute('aria-label') || element.innerText || element.getAttribute('placeholder') || element.getAttribute('name') || '').trim().slice(0, 300),
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
    })),
  };
})()`;

const INTERACT_PAGE_SCRIPT = `(action) => {
  const element = document.querySelector(action.selector);
  if (!element) throw new Error('element not found: ' + action.selector);
  if (element.disabled || element.getAttribute('aria-disabled') === 'true') throw new Error('element is disabled');
  if (action.action === 'click') {
    element.click();
    return;
  }
  if (!('value' in element)) throw new Error('element does not accept a value');
  element.focus();
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('element value cannot be changed');
  setter.call(element, action.value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}`;

function parseInteraction(input: unknown): BrowserInteraction {
  if (!input || typeof input !== 'object') throw new Error('browser interaction must be an object');
  const record = input as Record<string, unknown>;
  const action = record.action;
  const selector = requiredString(input, 'selector');
  if (selector.length > MAX_SELECTOR_LENGTH) throw new Error(`selector exceeds ${MAX_SELECTOR_LENGTH} characters`);
  if (action === 'click') return { action, selector };
  if (action !== 'type' && action !== 'select') throw new Error("action must be 'click', 'type', or 'select'");
  const value = requiredString(input, 'value', true);
  if (value.length > MAX_INPUT_LENGTH) throw new Error(`input value exceeds ${MAX_INPUT_LENGTH} characters`);
  return { action, selector, value };
}

function requiredString(input: unknown, key: string, allowEmpty = false): string {
  if (!input || typeof input !== 'object') throw new Error('tool input must be an object');
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) throw new Error(`'${key}' must be a string`);
  return value;
}

function validateUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('browser URL must be absolute');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('browser only permits HTTP and HTTPS URLs');
  if (url.username || url.password) throw new Error('browser URL must not contain embedded credentials');
  return url.href;
}

function safeDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    const query = [...url.searchParams.keys()].map((key) => `${key}=[hidden]`).join('&');
    return `${url.protocol}//${url.host}${url.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return 'the requested URL';
  }
}

function browserAuditSummary(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const record = result as Record<string, unknown>;
  return {
    url: typeof record.url === 'string' ? safeDisplayUrl(record.url) : undefined,
    title: record.title,
    truncated: record.truncated,
    elementCount: Array.isArray(record.elements) ? record.elements.length : undefined,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw browserAbortError();
}

function withBrowserDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(browserAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finishResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => finishReject(browserAbortError());
    timer = setTimeout(() => finishReject(new Error(`browser ${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    operation.then(finishResolve, finishReject);
  });
}

function browserAbortError(): Error {
  const error = new Error('browser operation cancelled');
  error.name = 'AbortError';
  return error;
}
