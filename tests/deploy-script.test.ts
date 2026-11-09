import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, delimiter, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// Executed by the Linux CI/container suite; these commands never contact Google Cloud.
const suite = process.platform === 'win32' ? describe.skip : describe;
function runDeployment(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gram-deploy-test-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'scripts', 'gcp'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', 'gcp', 'deploy.sh'),
    readFileSync(new URL('../scripts/gcp/deploy.sh', import.meta.url)),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'synthetic-lock-for-mocked-commands');
  const cli = `#!/usr/bin/env node
const fs=require('node:fs'); const path=require('node:path');
const name=path.basename(process.argv[1]); const args=process.argv.slice(2); const line=args.join(' ');
fs.appendFileSync(process.env.MOCK_TRACE,JSON.stringify({name,args})+'\\n');
if(name==='python3') {
 let data=fs.existsSync('deployment-record.json')?JSON.parse(fs.readFileSync('deployment-record.json','utf8')):{};
 if(args.length===2) data.status=args[1]; else Object.assign(data,{botImage:args[1],migrationImage:args[2],release:args[5]});
 fs.writeFileSync('deployment-record.json',JSON.stringify(data)); process.exit(0);
}
if(name==='docker') { if(args[0]==='inspect') console.log(process.env.MOCK_IMAGE_REVISION||'tested-commit'); process.exit(0); }
if(process.env.MOCK_FAIL==='worker'&&line.startsWith('run worker-pools deploy'))process.exit(1);
if(process.env.MOCK_FAIL==='verify'&&line.startsWith('run jobs execute synthetic-bot-verify'))process.exit(1);
if(line.startsWith('artifacts docker images describe'))console.log('registry.invalid/image@sha256:'+'a'.repeat(64));
else if(line.includes('--format=export'))console.log('apiVersion: serving.knative.dev/v1\\nkind: SyntheticSnapshot');
else if(line.includes('value(status.url)'))console.log('https://synthetic.run.app');
else if(line.includes('value(spec.template.spec.containers[0].image)'))console.log('registry.invalid/previous@sha256:'+'b'.repeat(64));
`;
  for (const name of ['gcloud', 'docker', 'python3']) {
    const path = join(bin, name);
    writeFileSync(path, cli);
    chmodSync(path, 0o755);
  }
  try {
    const result = spawnSync('bash', ['scripts/gcp/deploy.sh'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        MOCK_TRACE: join(root, 'trace'),
        MOCK_FAIL: '',
        MOCK_IMAGE_REVISION: '',
        GCP_PROJECT_ID: 'synthetic-project',
        GCP_REGION: 'europe-west1',
        GCP_ARTIFACT_REPO: 'test',
        GCP_SERVICE_NAME: 'synthetic-bot',
        GCP_WORKER_POOL: 'synthetic-worker',
        GCP_MIGRATE_JOB: 'synthetic-migration',
        GCP_SQL_CONNECTION_NAME: 'test:region:db',
        GCP_RUN_SERVICE_ACCOUNT: 'test@example.invalid',
        GCP_VPC_NETWORK: 'test',
        GCP_VPC_SUBNET: 'test',
        GCP_ADMIN_TELEGRAM_ID: '123456789',
        GCP_BOT_TOKEN_SECRET: 'bot-secret',
        GCP_DATABASE_URL_SECRET: 'db-secret',
        GCP_WEBHOOK_SECRET_SECRET: 'webhook-secret',
        GCP_METRICS_TOKEN_SECRET: 'metrics-secret',
        GCP_SENTRY_DSN_SECRET: 'sentry-secret',
        GCP_REDIS_ENABLED: '0',
        GCP_BOT_TOKEN_VERSION: '1',
        GCP_DATABASE_URL_VERSION: '1',
        GCP_WEBHOOK_SECRET_VERSION: '1',
        GCP_REDIS_URL_VERSION: '1',
        GCP_MIGRATION_DATABASE_URL_VERSION: '1',
        GCP_METRICS_TOKEN_VERSION: '1',
        GCP_SENTRY_DSN_VERSION: '1',
        GCP_BOT_IMAGE_DIGEST: '',
        GCP_MIGRATION_IMAGE_DIGEST: '',
        GCP_BOOTSTRAP: '0',
        GITHUB_SHA: 'tested-commit',
        GCP_SUPPORT_CONTACT: '@synthetic',
        GCP_PRIVACY_POLICY_URL: 'https://policy.invalid',
        ...extra,
      },
    });
    const trace = existsSync(join(root, 'trace'))
      ? readFileSync(join(root, 'trace'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { name: string; args: string[] })
      : [];
    const record = existsSync(join(root, 'deployment-record.json'))
      ? (JSON.parse(readFileSync(join(root, 'deployment-record.json'), 'utf8')) as Record<
          string,
          string
        >)
      : {};
    return { status: result.status, output: result.stdout + result.stderr, trace, record };
  } finally {
    if (basename(root).startsWith('gram-deploy-test-')) rmSync(root, { recursive: true, force: true });
  }
}

suite('production deployment shell contract', () => {
  it('uses immutable images, preserves monitoring bindings and verifies after deployment', () => {
    const result = runDeployment();
    expect(result.status, result.output).toBe(0);
    expect(result.record.status).toBe('verified');
    const deployments = result.trace.filter(
      (call) =>
        call.name === 'gcloud' &&
        (call.args.slice(0, 2).join(' ') === 'run deploy' ||
          call.args.slice(0, 3).join(' ') === 'run worker-pools deploy'),
    );
    expect(deployments).toHaveLength(2);
    for (const call of deployments) {
      const args = call.args.join(' ');
      expect(args).toContain('@sha256:');
      expect(args).toContain('METRICS_TOKEN=metrics-secret:1');
      expect(args).toContain('SENTRY_DSN=sentry-secret:1');
      expect(args).toContain('--remove-secrets REDIS_URL');
    }
    expect(
      result.trace.some(
        (call) => call.args.slice(0, 4).join(' ') === 'run jobs execute synthetic-bot-verify',
      ),
    ).toBe(true);
  });
  it.each(['worker', 'verify'])('restores both previous configurations when %s fails', (failure) => {
    const result = runDeployment({ MOCK_FAIL: failure });
    expect(result.status).toBe(1);
    expect(result.record.status).toBe('failed');
    expect(result.trace.some((call) => call.args.slice(0, 3).join(' ') === 'run services replace')).toBe(
      true,
    );
    expect(
      result.trace.some((call) => call.args.slice(0, 3).join(' ') === 'run worker-pools replace'),
    ).toBe(true);
  });
  it('refuses unpinned secrets before any cloud mutation', () => {
    const result = runDeployment({ GCP_BOT_TOKEN_VERSION: 'latest' });
    expect(result.status).toBe(1);
    expect(result.trace).toHaveLength(0);
  });
  it('promotes matching tested artifacts without a new Cloud Build', () => {
    const result = runDeployment({
      GCP_BOT_IMAGE_DIGEST: 'registry.invalid/bot@sha256:' + 'a'.repeat(64),
      GCP_MIGRATION_IMAGE_DIGEST: 'registry.invalid/migrate@sha256:' + 'b'.repeat(64),
    });
    expect(result.status, result.output).toBe(0);
    expect(result.trace.some((call) => call.args[0] === 'builds')).toBe(false);
  });
  it('rejects promoted artifacts from a different source revision', () => {
    const result = runDeployment({
      GCP_BOT_IMAGE_DIGEST: 'registry.invalid/bot@sha256:' + 'a'.repeat(64),
      GCP_MIGRATION_IMAGE_DIGEST: 'registry.invalid/migrate@sha256:' + 'b'.repeat(64),
      MOCK_IMAGE_REVISION: 'different-commit',
    });
    expect(result.status).toBe(1);
    expect(result.trace.some((call) => call.args[0] === 'run')).toBe(false);
  });
  it('records bootstrap as incomplete webhook verification', () => {
    const result = runDeployment({ GCP_BOOTSTRAP: '1' });
    expect(result.status, result.output).toBe(0);
    expect(result.record.status).toBe('bootstrap');
  });
});
