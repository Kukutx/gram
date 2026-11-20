import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const suite = process.platform === 'win32' ? describe.skip : describe;
const read = (name: string) => readFileSync(new URL(`../deploy/${name}`, import.meta.url), 'utf8');

suite('one-command install scripts', () => {
  it.each(['gcp-free.sh', 'oracle-free.sh', 'server-install.sh', 'up.sh', 'backup.sh'])(
    '%s is valid bash',
    (name) => {
      const result = spawnSync('bash', ['-n', new URL(`../deploy/${name}`, import.meta.url).pathname]);
      expect(result.stderr.toString()).toBe('');
      expect(result.status).toBe(0);
    },
  );

  it.each(['gcp-free.sh', 'oracle-free.sh'])(
    '%s sends the bot token over stdin, never on a command line',
    (name) => {
      const script = read(name);
      const sshCommands = script.split('\n').filter((line) => line.includes('ssh_vm '));
      expect(sshCommands.length).toBeGreaterThan(0);
      for (const line of sshCommands) expect(line).not.toContain('TOKEN');
      expect(script).toContain('tee -a /etc/gram/env.install');
    },
  );

  it('stays inside the GCP free tier', () => {
    const script = read('gcp-free.sh');
    expect(script).toContain('--machine-type=e2-micro');
    expect(script).toContain('--boot-disk-type=pd-standard');
    expect(script).toMatch(/--boot-disk-size=30GB/);
    const zones = script.match(/ZONES=\(\$\{GRAM_ZONE:-([^}]*)\}\)/)?.[1]?.split(' ') ?? [];
    expect(zones.length).toBeGreaterThan(0);
    for (const zone of zones) expect(zone).toMatch(/^us-(central1|west1|east1)-[a-f]$/);
  });

  it('keeps generated secrets and settings across re-runs', () => {
    const script = read('server-install.sh');
    expect(script).toMatch(/\[\[ -s \.env \]\] \|\| cp \.env\.example \.env/);
    expect(script).toMatch(/get_env POSTGRES_PASSWORD\)" \]\] \|\| set_env POSTGRES_PASSWORD/);
    expect(script).toContain('rm -f "$INSTALL_ENV"');
  });

  it('only asks Oracle for Always Free shapes within the free allowance', () => {
    const script = read('oracle-free.sh');
    const shapes = [...script.matchAll(/launch (VM\.[\w.]+)/g)].map((m) => m[1]);
    expect(shapes).toEqual(['VM.Standard.A1.Flex', 'VM.Standard.E2.1.Micro']);
    expect(script).toContain('OCPUS="${GRAM_OCPUS:-2}"');
    expect(script).toContain('MEMORY_GB="${GRAM_MEMORY_GB:-12}"');
    expect(script).toContain('--boot-volume-size-in-gbs 50');
    expect(script).toContain('export OCI_CLI_REGION="$HOME_REGION"');
    // Cloud Shell runs in FIPS mode: ed25519 keys are refused there.
    expect(script).toContain('ssh-keygen -q -t rsa -b 4096');
    expect(script).not.toMatch(/-t ed25519/);
  });

  it('copies backups off the server through a write-only link only', () => {
    const script = read('oracle-free.sh');
    expect(script).toContain('--access-type AnyObjectWrite');
    expect(script).not.toMatch(/--public-access-type/);
    const backup = read('backup.sh');
    expect(backup).toContain('BACKUP_UPLOAD_URL');
    expect(backup).toMatch(/gram-day-\$\(date -u \+%d\)/);
  });
});
