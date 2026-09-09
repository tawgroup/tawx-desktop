import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopWorkspaceUrl, workspacePost } from '../src/components/cowork/integrationUrls.ts';

test('restored workspace is sent with artifact and status requests', () => {
  const workspace = '/Users/dev/Restored project #1';
  assert.equal(
    desktopWorkspaceUrl('/desktop/artifacts', workspace),
    '/desktop/artifacts?workspace=%2FUsers%2Fdev%2FRestored%20project%20%231',
  );
  assert.equal(
    desktopWorkspaceUrl('/desktop/integrations?view=status', workspace),
    '/desktop/integrations?view=status&workspace=%2FUsers%2Fdev%2FRestored%20project%20%231',
  );
});

test('restored workspace is sent in MCP connect JSON without changing the fallback request', () => {
  const request = workspacePost('/Users/dev/restored');
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(String(request.body)), { workspace: '/Users/dev/restored' });
  assert.deepEqual(workspacePost(), { method: 'POST' });
});
