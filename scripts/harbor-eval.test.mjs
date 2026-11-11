import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildHarborArgs,
  harborModelArg,
  parseEnvText,
  resolveHarborConfig,
  rewriteLoopback,
} from './harbor-eval.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('parses env assignments and ignores comments', () => {
  const env = parseEnvText('# note\nHARBOR_API_KEY="secret"\n\nHARBOR_MODEL=a/b\n');
  assert.deepEqual(env, { HARBOR_API_KEY: 'secret', HARBOR_MODEL: 'a/b' });
});

test('reads the harbor key from the env and refuses a missing key, model, or base url', () => {
  assert.throws(
    () => resolveHarborConfig({ HARBOR_MODEL: 'm', HARBOR_BASE_URL: 'http://example.test/v1' }),
    /HARBOR_API_KEY/
  );
  assert.throws(
    () => resolveHarborConfig({ HARBOR_API_KEY: 'k', HARBOR_BASE_URL: 'http://example.test/v1' }),
    /HARBOR_MODEL/
  );
  const config = resolveHarborConfig({
    HARBOR_API_KEY: 'k',
    HARBOR_MODEL: 'vendor/model',
    HARBOR_BASE_URL: 'http://127.0.0.1:9/v1',
  });
  assert.equal(config.keyName, 'HARBOR_API_KEY');
  assert.equal(config.apiKey, 'k');
  assert.equal(config.model, 'vendor/model');
  assert.equal(config.baseUrl, 'http://host.docker.internal:9/v1');
  assert.equal(config.apiFormat, 'openai_responses');
});

test('keeps a model id that contains slashes behind the protocol prefix', () => {
  assert.equal(harborModelArg('vendor/model', 'openai_responses'), 'openai/vendor/model');
  assert.equal(harborModelArg('openai/vendor/model', 'openai_responses'), 'openai/vendor/model');
  assert.equal(harborModelArg('claude', 'anthropic_messages'), 'anthropic/claude');
  assert.equal(rewriteLoopback('http://localhost:3425/v1'), 'http://host.docker.internal:3425/v1');
  assert.equal(rewriteLoopback('https://api.example.test/v1'), 'https://api.example.test/v1');
});

test('passes HARBOR_API_KEY through and does not embed connection settings', async () => {
  const args = buildHarborArgs({
    dataset: 'terminal-bench@2.0',
    limit: '2',
    concurrency: '1',
    jobsDir: '/tmp/jobs',
    jobName: 'smoke',
    config: resolveHarborConfig({
      HARBOR_API_KEY: 'k',
      HARBOR_MODEL: 'vendor/model',
      HARBOR_BASE_URL: 'https://api.example.test/v1',
      HARBOR_API_FORMAT: 'openai-completions',
    }),
  });
  assert.equal(args[args.indexOf('--api-key-name') + 1], 'HARBOR_API_KEY');
  assert.equal(args[args.indexOf('-m') + 1], 'openai/vendor/model');
  assert.equal(args[args.indexOf('--api-format') + 1], 'openai_chat_completions');
  assert.equal(args[args.indexOf('--base-url') + 1], 'https://api.example.test/v1');
  const source = await readFile(path.join(here, 'harbor-eval.mjs'), 'utf8');
  assert.equal(source.includes('cline-pass'), false);
  assert.equal(source.includes('3425'), false);
  assert.equal(source.includes('MAGPIE'), false);
});
