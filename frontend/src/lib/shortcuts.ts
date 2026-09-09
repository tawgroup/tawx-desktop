export const APP_COMMANDS = [
  'new-chat',
  'previous-chat',
  'next-chat',
  'mode-chat',
  'mode-cowork',
  'mode-code',
  'focus-composer',
  'open-settings',
  'toggle-context',
  'toggle-sidebar',
  'search-chats',
  'stop-generation',
  'show-shortcuts',
] as const;

export type AppCommand = (typeof APP_COMMANDS)[number];

const APP_COMMAND_SET: Record<string, true> = Object.fromEntries(
  APP_COMMANDS.map((command) => [command, true]),
);

export function commandForKeyboardEvent(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): AppCommand | undefined {
  const primary = event.metaKey || event.ctrlKey;
  if (!primary) return undefined;
  const key = event.key.toLowerCase();

  if (event.altKey) {
    if (!event.shiftKey && key === 'x') return 'toggle-context';
    if (!event.shiftKey && key === 's') return 'toggle-sidebar';
    return undefined;
  }
  if (event.shiftKey) return key === 'k' ? 'focus-composer' : undefined;

  const commandByKey: Record<string, AppCommand> = {
    n: 'new-chat',
    '[': 'previous-chat',
    ']': 'next-chat',
    '1': 'mode-chat',
    '2': 'mode-cowork',
    '3': 'mode-code',
    ',': 'open-settings',
    k: 'search-chats',
    '.': 'stop-generation',
  };
  return commandByKey[key];
}

export function subscribeNativeCommands(listener: (command: AppCommand) => void): () => void {
  return window.tawxDesktop?.onCommand((value) => {
    if (APP_COMMAND_SET[value]) listener(value as AppCommand);
  }) ?? (() => undefined);
}

declare global {
  interface Window {
    tawxDesktop?: {
      onCommand(listener: (command: string) => void): () => void;
    };
  }
}
