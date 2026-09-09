import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadConfig, expandEnv } from './config.js';

const REAL_CONFIG = join(__dirname, '..', '..', '..', 'etc', 'config.desktop.yaml');
const STANDALONE_ENV = { OPENROUTER_API_KEY: 'sk-or-test' };

// must await before restoring: an env snapshot put back while the load is
// still in flight leaves the loader reading the original environment
async function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('expandEnv handles both $VAR and ${VAR}', () => {
  const env = { FOO: 'bar' };
  assert.equal(expandEnv('${FOO}', env), 'bar');
  assert.equal(expandEnv('$FOO/baz', env), 'bar/baz');
  assert.equal(expandEnv('${MISSING}', env), '');
});

// the app's real config is the one thing a first boot cannot afford to get
// wrong, so it is parsed here rather than a hand-written fixture
test('the shipped desktop config loads with standalone OpenRouter routing', async () => {
  const config = await withEnv(STANDALONE_ENV, () => loadConfig(REAL_CONFIG));

  assert.equal(config.listen, '127.0.0.1:18080');
  assert.equal(config.providers?.open_router?.api_key, 'sk-or-test');
  assert.equal(config.providers?.local, undefined);

  const routing = config.routing;
  assert.ok(routing, 'the routing block must be bound, not left as raw YAML');
  assert.equal(routing.defaultRoute, 'fast');
  assert.equal(routing.classifier?.enabled, true);
  assert.equal(routing.classifier?.provider, 'open_router');
  assert.equal(routing.classifier?.model, 'openrouter/openai/gpt-5.6-luna');
  assert.equal(routing.heuristics?.enabled, true);

  assert.deepEqual(
    routing.routes.map((route) => [route.name, route.model]),
    [
      ['fast', 'openrouter/openai/gpt-5.6-sol'],
      ['coding', 'openrouter/openai/gpt-5.6-sol'],
      ['reasoning', 'openrouter/openai/gpt-5.6-sol'],
      ['creative', 'openrouter/openai/gpt-5.6-sol'],
      ['general', 'openrouter/openai/gpt-5.6-sol'],
    ],
  );
});

test('an unset variable fails the load instead of resolving empty', async () => {
  await assert.rejects(
    () => withEnv({ OPENROUTER_API_KEY: '' }, () => loadConfig(REAL_CONFIG)),
    /resolves empty/,
  );
});
