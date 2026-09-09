import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadConfig, expandEnv } from './config.js';

const REAL_CONFIG = join(__dirname, '..', '..', '..', 'etc', 'config.omp.yaml');

/** The variables run-with-omp used to export before the gateway started. */
const OMP_ENV = {
  OPENROUTER_API_KEY: 'sk-or-test',
  OMP_AUTH_GATEWAY_URL: 'http://127.0.0.1:19101',
  OMP_ROUTER_CLASSIFIER_MODEL: 'test/smol',
  OMP_ROUTER_FAST_MODEL: 'test/fast',
  OMP_ROUTER_CODING_MODEL: 'test/coding',
  OMP_ROUTER_REASONING_MODEL: 'test/reasoning',
  OMP_ROUTER_CREATIVE_MODEL: 'test/creative',
  OMP_ROUTER_GENERAL_MODEL: 'test/general',
};

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
test('the shipped OMP config loads with providers and routing resolved', async () => {
  const config = await withEnv(OMP_ENV, () => loadConfig(REAL_CONFIG));

  assert.equal(config.listen, '127.0.0.1:18080');
  assert.equal(config.providers?.open_router?.api_key, 'sk-or-test');
  assert.equal(config.providers?.local?.base_url, 'http://127.0.0.1:19101');

  const routing = config.routing;
  assert.ok(routing, 'the routing block must be bound, not left as raw YAML');
  assert.equal(routing.defaultRoute, 'fast');
  assert.equal(routing.classifier?.enabled, true);
  assert.equal(routing.classifier?.model, 'test/smol');
  assert.equal(routing.heuristics?.enabled, true);

  assert.deepEqual(
    routing.routes.map((route) => [route.name, route.model]),
    [
      ['fast', 'test/fast'],
      ['coding', 'test/coding'],
      ['reasoning', 'test/reasoning'],
      ['creative', 'test/creative'],
      ['general', 'test/general'],
    ],
  );
});

test('an unset variable fails the load instead of resolving empty', async () => {
  const env = { ...OMP_ENV } as Record<string, string>;
  delete env.OMP_ROUTER_FAST_MODEL;

  await assert.rejects(
    () =>
      withEnv({ ...env, OMP_ROUTER_FAST_MODEL: '' }, () => loadConfig(REAL_CONFIG)),
    /resolves empty/,
  );
});
