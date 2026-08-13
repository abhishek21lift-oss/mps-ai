'use strict';
// What the image is allowed to contain.
//
// This service argues that it is safe partly because it holds nothing worth
// stealing, and config.js enforces that by refusing to boot on a forbidden
// secret. But it does legitimately hold two — AI_API_KEY and
// SERVICE_AUTH_SECRET — and the Dockerfile ends in `COPY . .`.
//
// Docker does not read .gitignore. So until .dockerignore existed, building on
// any machine where somebody had followed the README's own setup step
// (`cp .env.example .env`) baked both secrets into an image layer: readable by
// anyone who can pull it, and still there after the file is deleted, because
// layers are immutable.
//
// Asserted as a file-shape test for the same reason the forbidden-secret check
// is a boot-time assertion rather than a comment — the realistic way this gets
// undone is somebody adding a path back, or deleting the file wholesale.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

describe('the Docker build context', () => {
  test('a .dockerignore exists at all', () => {
    expect(fs.existsSync(path.join(root, '.dockerignore'))).toBe(true);
  });

  const lines = () => read('.dockerignore')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  test.each([
    ['.env', 'AI_API_KEY and SERVICE_AUTH_SECRET live here'],
    ['.env.*', 'so does .env.local'],
    ['node_modules', 'would overwrite the --omit=dev install with the host\'s'],
    ['.git', 'carries every secret ever committed and then removed'],
  ])('excludes %s — %s', (entry) => {
    expect(lines()).toContain(entry);
  });

  test('the example file is still allowed through', () => {
    // `.env.*` would otherwise take .env.example with it, and that one is
    // documentation rather than a secret.
    expect(lines()).toContain('!.env.example');
  });

  test('everything the service needs at runtime is still included', () => {
    // The failure mode on the other side: an over-broad ignore that excludes
    // src/ and produces an image which builds cleanly and cannot start.
    const ignored = lines();
    for (const needed of ['src', 'package.json', 'package-lock.json']) {
      expect(ignored).not.toContain(needed);
    }
  });
});

describe('the Dockerfile still relies on it', () => {
  test('it copies the whole context, which is why the ignore file matters', () => {
    // If this line ever becomes an explicit allow-list of paths, .dockerignore
    // stops being load-bearing and this suite should be revisited rather than
    // silently kept passing.
    expect(read('Dockerfile')).toMatch(/COPY\s+--chown=express:nodejs\s+\.\s+\./);
  });

  test('production deps are installed with --omit=dev', () => {
    expect(read('Dockerfile')).toMatch(/npm ci --omit=dev/);
  });

  test('it does not run as root', () => {
    expect(read('Dockerfile')).toMatch(/^USER express$/m);
  });
});

describe('the compose snippet carries no secret values', () => {
  test('every secret is an interpolation, never a literal', () => {
    // The snippet is committed, so a real key pasted into it would be public.
    const snippet = read('docker-compose.snippet.yml');
    for (const key of ['AI_API_KEY', 'SERVICE_AUTH_SECRET']) {
      const line = snippet.split('\n').find((l) => l.trim().startsWith(`${key}:`));
      expect(line).toBeDefined();
      expect(line).toMatch(/\$\{[A-Z_]+\}/);
    }
  });

  test('it does not reintroduce a forbidden secret', () => {
    const { FORBIDDEN } = require('../src/config');
    const snippet = read('docker-compose.snippet.yml');
    for (const key of FORBIDDEN) {
      // Named in a warning comment is fine; assigned is not.
      expect(snippet).not.toMatch(new RegExp(`^\\s*${key}:`, 'm'));
    }
  });
});
