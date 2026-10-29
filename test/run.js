'use strict';
// Standalone-package test suite for pydrift-ci. Exercises the exact exported functions the
// shipped cli.js ships against real fixture trees on disk (.python-version, pyproject.toml,
// Dockerfile, .github/workflows/*.yml) — never a mocked file tree.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const {
  buildReport, verifyLicenseWith, parseVersionKey, parseRequiresPythonRange, keySatisfiesRange,
  findDockerfilePins, findWorkflowPins, readPythonVersionFile, readPyprojectRequiresPython,
} = require('../cli.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('  ok -', name);
  }).catch((err) => {
    failures.push({ name, err });
    console.log('FAIL -', name, '\n       ', err.message);
  });
}

const FIXTURES = path.join(__dirname, 'fixtures');

async function main() {
  await check('parseVersionKey extracts major.minor as a comparable integer, null when ambiguous', () => {
    assert.equal(parseVersionKey('3.11.4'), 311);
    assert.equal(parseVersionKey('3.9'), 309);
    assert.equal(parseVersionKey('python:3.11-slim'), 311);
    assert.equal(parseVersionKey('3'), null);
    assert.equal(parseVersionKey('latest'), null);
  });

  await check('parseRequiresPythonRange handles >=, >=/< pair, ~=, ==X.Y.*, and a bare X.Y', () => {
    assert.deepEqual(parseRequiresPythonRange('>=3.9'), { min: 309, max: null, exact: null });
    assert.deepEqual(parseRequiresPythonRange('>=3.9,<3.13'), { min: 309, max: 313, exact: null });
    assert.deepEqual(parseRequiresPythonRange('~=3.10'), { min: 310, max: 311, exact: null });
    assert.deepEqual(parseRequiresPythonRange('==3.11.*'), { min: null, max: null, exact: 311 });
    assert.deepEqual(parseRequiresPythonRange('3.11'), { min: null, max: null, exact: 311 });
    assert.equal(parseRequiresPythonRange(''), null);
  });

  await check('keySatisfiesRange: a floor-only range never flags a HIGHER minor', () => {
    const range = parseRequiresPythonRange('>=3.9');
    assert.equal(keySatisfiesRange(311, range), true);
    assert.equal(keySatisfiesRange(309, range), true);
    assert.equal(keySatisfiesRange(308, range), false);
  });

  await check('keySatisfiesRange: a bounded range excludes keys outside [min, max)', () => {
    const range = parseRequiresPythonRange('>=3.9,<3.11');
    assert.equal(keySatisfiesRange(309, range), true);
    assert.equal(keySatisfiesRange(310, range), true);
    assert.equal(keySatisfiesRange(311, range), false);
    assert.equal(keySatisfiesRange(308, range), false);
  });

  await check('readPythonVersionFile reads the first line, null when absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pydrift-pv-'));
    fs.writeFileSync(path.join(dir, '.python-version'), '3.11.4\n');
    assert.deepEqual(readPythonVersionFile(dir), { raw: '3.11.4', key: 311 });
    assert.equal(readPythonVersionFile(os.tmpdir() + '/does-not-exist-pydrift'), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('readPyprojectRequiresPython reads requires-python from pyproject.toml, null when absent or missing field', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pydrift-pyproj-'));
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\nrequires-python = ">=3.9"\n');
    assert.equal(readPyprojectRequiresPython(dir).raw, '>=3.9');
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    assert.equal(readPyprojectRequiresPython(dir), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findDockerfilePins finds every "FROM python:X.Y" across any Dockerfile*, skips unversioned tags', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pydrift-docker-'));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM python:3.9-slim\nRUN echo hi\n');
    fs.mkdirSync(path.join(dir, 'services', 'api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'services', 'api', 'Dockerfile.prod'), 'FROM python:latest\nFROM python:3.11\n');
    const pins = findDockerfilePins(dir);
    assert.equal(pins.length, 2); // the unversioned "python:latest" FROM is skipped
    assert.deepEqual(pins.map((p) => p.key).sort(), [309, 311]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findWorkflowPins reads a scalar python-version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pydrift-wf-scalar-'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), [
      'jobs:', '  test:', '    steps:', '      - uses: actions/setup-python@v5',
      '        with:', "          python-version: '3.11'", '',
    ].join('\n'));
    const pins = findWorkflowPins(dir);
    assert.equal(pins.length, 1);
    assert.equal(pins[0].key, 311);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findWorkflowPins treats a block-style matrix list as matrix, not a comparable pin', () => {
    const pins = findWorkflowPins(path.join(FIXTURES, 'matrix'));
    const matrixPins = pins.filter((p) => p.matrix);
    assert.equal(matrixPins.length, 1);
    assert.deepEqual(matrixPins[0].values, ['3.9', '3.10', '3.11']);
  });

  await check('buildReport free mode (no Pro): consistent fixture has zero findings', () => {
    const result = buildReport(path.join(FIXTURES, 'consistent'), { pro: false });
    assert.equal(result.breach, false);
    assert.equal(result.pro, false);
    // Dockerfile/CI pins are not even collected in free mode.
    assert.equal(result.sources.pins.length, 1);
  });

  await check('buildReport Pro mode: consistent fixture (.python-version=3.11, requires-python>=3.9, Dockerfile python:3.11, CI 3.11) is clean', () => {
    const result = buildReport(path.join(FIXTURES, 'consistent'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.sources.pins.length, 3);
  });

  await check('buildReport Pro mode: drift fixture flags both pinMismatch and requiresPythonMismatch', () => {
    const result = buildReport(path.join(FIXTURES, 'drift'), { pro: true });
    assert.equal(result.breach, true);
    assert.ok(result.findings.some((f) => f.rule === 'pinMismatch'));
    assert.ok(result.findings.some((f) => f.rule === 'requiresPythonMismatch'));
  });

  await check('buildReport free mode on the drift fixture: requires-python upper bound still catches .python-version, even without Docker/CI scanning', () => {
    const result = buildReport(path.join(FIXTURES, 'drift'), { pro: false });
    assert.equal(result.breach, true);
    assert.equal(result.findings.every((f) => f.rule === 'requiresPythonMismatch'), true);
    assert.equal(result.sources.pins.length, 1); // .python-version only — no Dockerfile/CI pin collected
  });

  await check('buildReport Pro mode: a deliberate version matrix in CI is reported as skipped, never as drift', () => {
    const result = buildReport(path.join(FIXTURES, 'matrix'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.matrixSources.length, 1);
  });

  await check('buildReport on a tree with only .python-version (no pyproject.toml, no Docker, no CI) is clean, not an error', () => {
    const result = buildReport(path.join(FIXTURES, 'minimal'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.sources.requiresPython, null);
  });

  await check('buildReport throws ConfigError when --dir does not exist', () => {
    assert.throws(() => buildReport(path.join(FIXTURES, 'does-not-exist'), {}), /is not a directory/);
  });

  await check('CLI end-to-end via real subprocess: free mode runs with no key, Pro mode engages with a real minted key', () => {
    const cliPath = path.join(__dirname, '..', 'cli.js');

    const runCli = (args, env) => {
      try {
        const out = execFileSync('node', [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
        return { code: 0, out };
      } catch (e) {
        return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
      }
    };

    // Free mode, no key at all: consistent fixture is still clean (exit 0), and the CLI runs
    // successfully rather than refusing outright — license absence narrows scope, it is not a
    // hard gate on the whole tool.
    const freeRun = runCli(['check', '--dir', path.join(FIXTURES, 'consistent')], { PYDRIFT_KEY: '' });
    assert.equal(freeRun.code, 0);
    assert.ok(freeRun.out.includes('free'));

    // Pro mode with a real minted key: the drift fixture now fails (Dockerfile pins 3.9
    // against a .python-version/CI of 3.11, which free mode alone could not see).
    const devVarsPath = path.join(os.homedir(), '.hive_devtools_license_keys', 'pydrift.dev.vars');
    const devVars = fs.readFileSync(devVarsPath, 'utf8');
    const privB64 = devVars.match(/LICENSE_PRIVATE_KEY=(\S+)/)[1];
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' });
    const payload = Buffer.from(JSON.stringify({ product: 'pydrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`PY1.${payload}`).end().sign(privateKey).toString('base64url');
    const realKey = `PY1.${payload}.${sig}`;

    const proRun = runCli(['check', '--dir', path.join(FIXTURES, 'drift')], { PYDRIFT_KEY: realKey });
    assert.equal(proRun.code, 1);
    assert.ok(proRun.out.includes('Pro'));

    const proCleanRun = runCli(['check', '--dir', path.join(FIXTURES, 'consistent')], { PYDRIFT_KEY: realKey });
    assert.equal(proCleanRun.code, 0);
  });

  await check('license: a key signed by the real private key verifies true against the matching public key', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'pydrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`PY1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`PY1.${payload}.${sig}`, pubPem), true);
  });

  await check('license: a tampered key is rejected', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'pydrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`PY1.${payload}`).end().sign(privateKey).toString('base64url');
    const tamperedPayload = Buffer.from(JSON.stringify({ product: 'pydrift-pro', iat: 0 })).toString('base64url');
    assert.equal(verifyLicenseWith(`PY1.${tamperedPayload}.${sig}`, pubPem), false);
  });

  await check('license: non-canonical base64url (coin-flip tamper-bypass shape) is rejected, not accepted by luck', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'pydrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`PY1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`PY1.${payload}.${sig}AB`, pubPem), false);
  });

  await check('license: a key signed by a DIFFERENT private key is rejected by this public key', () => {
    const { publicKey: pubA } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { privateKey: privB } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPemA = pubA.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'pydrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`PY1.${payload}`).end().sign(privB).toString('base64url');
    assert.equal(verifyLicenseWith(`PY1.${payload}.${sig}`, pubPemA), false);
  });

  await check('license: wrong product in the payload is rejected even with a valid signature', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'some-other-product', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`PY1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`PY1.${payload}.${sig}`, pubPem), false);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  else console.log('All pydrift-ci standalone test groups passed.');
}

main();
