import assert from 'node:assert/strict';
import test from 'node:test';
import { installExternalNavigation, type ExternalNavigationTarget } from './navigation.js';

test('external links open in the system browser without creating an Electron child window', async () => {
  let openHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | undefined;
  let navigateHandler: ((event: { preventDefault(): void }, url: string) => void) | undefined;
  const target: ExternalNavigationTarget = {
    setWindowOpenHandler(handler) {
      openHandler = handler;
    },
    on(event, handler) {
      assert.equal(event, 'will-navigate');
      navigateHandler = handler;
    },
  };
  const opened: string[] = [];

  installExternalNavigation(target, 'http://127.0.0.1:18080/', async (url) => {
    opened.push(url);
  });

  assert.deepEqual(openHandler?.({ url: 'https://cloudconvert.com/pdf-to-docx' }), { action: 'deny' });
  await Promise.resolve();
  assert.deepEqual(opened, ['https://cloudconvert.com/pdf-to-docx']);

  let prevented = false;
  navigateHandler?.({ preventDefault: () => { prevented = true; } }, 'https://example.com/docs');
  await Promise.resolve();
  assert.equal(prevented, true);
  assert.deepEqual(opened, ['https://cloudconvert.com/pdf-to-docx', 'https://example.com/docs']);

  prevented = false;
  navigateHandler?.({ preventDefault: () => { prevented = true; } }, 'http://127.0.0.1:18080/settings');
  assert.equal(prevented, false);

  assert.deepEqual(openHandler?.({ url: 'file:///tmp/secret' }), { action: 'deny' });
  await Promise.resolve();
  assert.deepEqual(opened, ['https://cloudconvert.com/pdf-to-docx', 'https://example.com/docs']);
});
