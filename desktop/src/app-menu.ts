import type { MenuItemConstructorOptions } from 'electron';

export type AppCommand =
  | 'new-chat'
  | 'previous-chat'
  | 'next-chat'
  | 'mode-chat'
  | 'mode-cowork'
  | 'mode-code'
  | 'focus-composer'
  | 'open-settings'
  | 'toggle-context'
  | 'toggle-sidebar'
  | 'search-chats'
  | 'stop-generation'
  | 'show-shortcuts';

type SendCommand = (command: AppCommand) => void;

function commandItem(
  label: string,
  accelerator: string | undefined,
  command: AppCommand,
  send: SendCommand,
): MenuItemConstructorOptions {
  return {
    label,
    ...(accelerator && { accelerator }),
    click: () => send(command),
  };
}

export function buildAppMenuTemplate(
  appName: string,
  isMac: boolean,
  send: SendCommand,
): MenuItemConstructorOptions[] {
  const settings = commandItem('Settings…', 'CommandOrControl+,', 'open-settings', send);
  return [
    ...(isMac ? [{
      label: appName,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        settings,
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        commandItem('New Chat', 'CommandOrControl+N', 'new-chat', send),
        ...(!isMac ? [{ type: 'separator' as const }, settings, { type: 'separator' as const }, { role: 'quit' as const }] : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        commandItem('Previous Chat', 'CommandOrControl+[', 'previous-chat', send),
        commandItem('Next Chat', 'CommandOrControl+]', 'next-chat', send),
        { type: 'separator' },
        commandItem('Search Chats', 'CommandOrControl+K', 'search-chats', send),
        commandItem('Focus Composer', 'CommandOrControl+Shift+K', 'focus-composer', send),
      ],
    },
    {
      label: 'Mode',
      submenu: [
        commandItem('Chat', 'CommandOrControl+1', 'mode-chat', send),
        commandItem('Cowork', 'CommandOrControl+2', 'mode-cowork', send),
        commandItem('Code', 'CommandOrControl+3', 'mode-code', send),
      ],
    },
    {
      label: 'View',
      submenu: [
        commandItem('Toggle Sidebar', 'CommandOrControl+Alt+S', 'toggle-sidebar', send),
        commandItem('Toggle Context Inspector', 'CommandOrControl+Alt+X', 'toggle-context', send),
        { type: 'separator' },
        // Chromium's own page zoom, which scales the whole UI and persists per
        // window. The accelerators come with the roles.
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Conversation',
      submenu: [commandItem('Stop Generating', 'CommandOrControl+.', 'stop-generation', send)],
    },
    {
      role: 'help',
      submenu: [commandItem('Keyboard Shortcuts', undefined, 'show-shortcuts', send)],
    },
  ];
}
