import assert from 'node:assert/strict';
import test from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';
import { buildAppMenuTemplate, type AppCommand } from './app-menu.js';

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ]);
}

test('native menu exposes every researched app shortcut and dispatches commands', () => {
  const commands: AppCommand[] = [];
  const items = flatten(buildAppMenuTemplate('TAWX Desktop', true, (command) => commands.push(command)));
  const acceleratorByLabel = Object.fromEntries(items.map((item) => [item.label, item.accelerator]));

  assert.equal(acceleratorByLabel['New Chat'], 'CommandOrControl+N');
  assert.equal(acceleratorByLabel['Previous Chat'], 'CommandOrControl+[');
  assert.equal(acceleratorByLabel['Next Chat'], 'CommandOrControl+]');
  assert.equal(acceleratorByLabel.Chat, 'CommandOrControl+1');
  assert.equal(acceleratorByLabel.Cowork, 'CommandOrControl+2');
  assert.equal(acceleratorByLabel.Code, 'CommandOrControl+3');
  assert.equal(acceleratorByLabel['Focus Composer'], 'CommandOrControl+Shift+K');
  assert.equal(acceleratorByLabel['Settings…'], 'CommandOrControl+,');
  assert.equal(acceleratorByLabel['Toggle Context Inspector'], 'CommandOrControl+Alt+X');
  assert.equal(acceleratorByLabel['Toggle Sidebar'], 'CommandOrControl+Alt+S');
  assert.equal(acceleratorByLabel['Search Chats'], 'CommandOrControl+K');
  assert.equal(acceleratorByLabel['Stop Generating'], 'CommandOrControl+.');

  const newChat = items.find((item) => item.label === 'New Chat');
  (newChat?.click as (() => void) | undefined)?.();
  assert.deepEqual(commands, ['new-chat']);
});
