import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const suite = process.platform === 'win32' ? describe.skip : describe;
const read = (name: string) => readFileSync(new URL(`../deploy/${name}`, import.meta.url), 'utf8');
const deployDir = new URL('../deploy/', import.meta.url).pathname;
const hasTools = ['git', 'flock'].every(
  (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
);

suite('one-command install scripts', () => {
  it.each([
    'gcp-free.sh',
    'oracle-free.sh',
    'server-install.sh',
    'up.sh',
    'backup.sh',
    'auto-update.sh',
    'lib.sh',
  ])('%s is valid bash', (name) => {
    const result = spawnSync('bash', ['-n', new URL(`../deploy/${name}`, import.meta.url).pathname]);
    expect(result.stderr.toString()).toBe('');
    expect(result.status).toBe(0);
  });

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

  it.each(['gcp-free.sh', 'oracle-free.sh'])(
    '%s passes an optional time zone and rejects a malformed one before doing anything',
    (name) => {
      const script = read(name);
      expect(script).toMatch(/SETTINGS\+="TIME_ZONE=\$(GRAM_TIME_ZONE|ZONE_SETTING)\\n"/);
      // The check sits before the first cloud CLI call, so a typo creates nothing.
      expect(script.indexOf('GRAM_TIME_ZONE=$GRAM_TIME_ZONE')).toBeLessThan(
        script.indexOf(name === 'gcp-free.sh' ? 'gcloud ' : 'oci '),
      );
      const check = script.match(/if \[\[ -n "\$\{GRAM_TIME_ZONE:-\}" \]\]; then[\s\S]*?\nfi\n/)?.[0];
      expect(check).toBeDefined();
      const run = (zone: string) =>
        spawnSync('bash', ['-c', `die() { exit 3; }\n${check}`], {
          env: { ...process.env, GRAM_TIME_ZONE: zone },
        }).status;
      expect(run('Europe/Rome')).toBe(0);
      expect(run('Not a zone')).toBe(3);
      expect(run('../../etc/passwd')).toBe(3);
    },
  );

  it.each(['gcp-free.sh', 'oracle-free.sh'])(
    '%s updates an existing server without asking anything',
    (name) => {
      const script = read(name);
      const existing = name === 'gcp-free.sh' ? '$ZONE' : '$INSTANCE';
      expect(script).toContain(
        `[[ -n "${existing}" && -z "$TOKEN" && -z "\${GRAM_CHANGE_TOKEN:-}" ]] && KEEP=1`,
      );
      expect(script).toContain('while [[ -z "$KEEP" ]]; do');
      // The /start messages read for the admin ID are acknowledged, so the bot does not answer them later.
      expect(script).toContain('getUpdates?offset=-1&timeout=0');
    },
  );

  it('defaults the time zone to the Oracle home region', () => {
    const script = read('oracle-free.sh');
    const fn = script.match(/region_time_zone\(\) \{[\s\S]*?\n\}\n/)?.[0];
    expect(fn).toBeDefined();
    const zone = (region: string) =>
      spawnSync('bash', ['-c', `${fn}\nregion_time_zone "$1"`, '_', region])
        .stdout.toString()
        .trim();
    expect(zone('eu-milan-1')).toBe('Europe/Rome');
    expect(zone('ap-tokyo-1')).toBe('Asia/Tokyo');
    expect(zone('us-ashburn-1')).toBe('America/New_York');
    expect(zone('xx-unknown-1')).toBe('');
  });

  it('schedules the daily self-update and rotates its logs', () => {
    const script = read('server-install.sh');
    expect(script).toMatch(/\$update_minute 4 \* \* \* root bash \$GRAM_DIR\/deploy\/auto-update\.sh/);
    expect(script).toContain('/etc/logrotate.d/gram');
    expect(script).toContain('flock -w 3600 9');
    // cron reads % as a newline, so none may appear in the generated crontab lines.
    const cron = script.match(/cat > \/etc\/cron\.d\/gram <<CRON\n([\s\S]*?)\nCRON/)?.[1] ?? '';
    expect(cron).toContain('auto-update.sh');
    expect(cron).not.toContain('%');
  });

  (hasTools ? it : it.skip)(
    'self-update installs a new commit, rolls back a broken one and tells the admins once',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'gram-update-'));
      try {
        const result = spawnSync('bash', ['-c', AUTO_UPDATE_SCENARIO, '_', root, deployDir], {
          encoding: 'utf8',
          env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
        });
        const out = result.stdout;
        expect(result.status, result.stderr).toBe(0);
        expect(out).toContain('#1 exit=0 head=A');
        expect(out).toContain('NOTIFY: ✅');
        expect(out).toContain('Add feature B');
        expect(out).toMatch(/#2 exit=0 head=Merge pull request/);
        expect(out).toMatch(/#3 exit=1 head=Merge pull request/); // rolled back to B
        expect(out.match(/NOTIFY: ⚠️/g)).toHaveLength(1); // the daily retry stays quiet
        expect(out).toMatch(/#4 exit=1 head=Merge pull request/);
        expect(out).toContain('AUTO_UPDATE is off.');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

/** Builds an origin repo and a "server" clone, then runs auto-update.sh through five rounds. */
const AUTO_UPDATE_SCENARIO = String.raw`
set -e
T="$1"; DEPLOY="$2"; cd "$T"; mkdir bin etc
printf '%s\n' '#!/bin/bash' 'cat >/dev/null' \
  'for a in "$@"; do [[ "$a" == text=* ]] && echo "NOTIFY: $(printf %s "$a" | cut -c6-)"; done; exit 0' > bin/curl
chmod +x bin/curl
commit() { git -c user.email=t@t -c user.name=t commit -q "$@"; }
git init -q --bare origin.git
git init -q -b develop work && cd work
mkdir deploy && cp "$DEPLOY/lib.sh" "$DEPLOY/auto-update.sh" deploy/
printf '%s\n' '#!/bin/bash' '[[ -f FAIL ]] && exit 1; exit 0' > deploy/up.sh
printf '%s\n' '#!/bin/bash' 'set -e' 'cd "$GRAM_DIR"' \
  'git checkout -q --force -B deploy "$GRAM_COMMIT"' 'bash deploy/up.sh' > deploy/server-install.sh
git add -A && commit -m A && git push -q "$T/origin.git" develop
cd "$T" && git clone -q --depth 1 --branch develop "file://$T/origin.git" server
cd server && git checkout -q -B deploy && printf 'BOT_TOKEN=1:x\nADMIN_IDS=5\n' > .env && cd "$T"
echo develop > etc/ref
n=0
run() {
  n=$((n + 1)); set +e
  PATH="$T/bin:$PATH" GRAM_DIR="$T/server" GRAM_ETC="$T/etc" GRAM_LOCK_FILE="$T/lock" \
    bash "$T/server/deploy/auto-update.sh" > "$T/out" 2>&1
  code=$?; set -e; cat "$T/out"
  echo "#$n exit=$code head=$(git -C "$T/server" log -1 --format=%s)"
}
run
cd work && echo 1 > f && git add f && commit -m 'Merge pull request #16 from x/y' -m 'Add feature B'
git push -q "$T/origin.git" develop && cd "$T"
run
cd work && touch FAIL && git add FAIL && commit -m 'C breaks' && git push -q "$T/origin.git" develop && cd "$T"
run
run
echo AUTO_UPDATE=false >> server/.env
run
`;
