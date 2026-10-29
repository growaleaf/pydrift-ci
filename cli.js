#!/usr/bin/env node
'use strict';

// pydrift-ci — self-contained, dependency-free (Node 18+, no npm install).
// Checks whether the Python version your team THINKS the project targets agrees across every
// place a project can declare one: .python-version (pyenv), pyproject.toml's "requires-python",
// any Dockerfile's "FROM python:X.Y", and any GitHub Actions workflow's "python-version:".
// Each of those is edited by a different person at a different time, so they drift silently —
// the same "works in CI, breaks in the Docker image" (or the reverse) bug this lane already
// shipped for Node.js (nodedrift-ci), ported to the Python ecosystem's own four files.
//
// FREE: compares .python-version against pyproject.toml's requires-python only. No key needed.
// PRO: also scans every Dockerfile and GitHub Actions workflow in the repo and cross-checks
//      every source against every other source. Unlocked by a valid offline license key — no
//      network call, no account, no phone-home.
//
// Usage:
//   node cli.js check [--dir <path>] [--json]
//
// Exit codes:
//   0 - no drift found
//   1 - a drift finding exists (any rule)
//   2 - configuration/usage error (--dir does not exist or is not a directory)

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------------------
// License (BP-001 offline ECDSA-P256 verify) — same chassis as every other D-lane standalone
// CLI, including the canonical-base64url round-trip check from the first line (the tamper-
// bypass coin-flip bug this lane found and fixed 2026-09-07, re-introduced once in
// localbolt-ci before being caught 2026-10-13, ported in from day one on every build since).
// ---------------------------------------------------------------------------------------
const PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWMy43NkH08PmVzh2Aq4By0zzL+l47uGIDqKGsak4xGjqA9k4U5LPml+Vui4v+KU71E7RpqsQxsh3gt9XeW6pcg==\n-----END PUBLIC KEY-----';
const LICENSE_PRODUCT = 'pydrift-pro';

function b64urlToBuf(s) {
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const canonical = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (canonical !== s) throw new Error('non-canonical base64url');
  return buf;
}

function verifyLicenseWith(key, pubPem) {
  try {
    if (typeof key !== 'string') return false;
    const parts = key.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'PY1') return false;
    const signedData = `PY1.${parts[1]}`;
    const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
    if (payload.product !== LICENSE_PRODUCT) return false;
    if (payload.exp && Date.now() > payload.exp) return false;
    const v = crypto.createVerify('SHA256');
    v.update(signedData); v.end();
    return v.verify(pubPem, b64urlToBuf(parts[2]));
  } catch (e) { return false; }
}

function verifyLicense(key) {
  if (PUBLIC_KEY_PEM.includes('PLACEHOLDER')) return false;
  return verifyLicenseWith(key, PUBLIC_KEY_PEM);
}

function readLicenseKey() {
  if (process.env.PYDRIFT_KEY) return process.env.PYDRIFT_KEY.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), '.pydrift', 'license'), 'utf8').trim();
  } catch (e) {
    return null;
  }
}

function hasPro() {
  const key = readLicenseKey();
  return !!(key && verifyLicense(key));
}

// ---------------------------------------------------------------------------------------
// Version-source parsing — Python versions are compared at MAJOR.MINOR granularity (3.9 vs
// 3.11 are different enough to matter; patch, e.g. 3.11.4 vs 3.11.9, never is), unlike Node
// where major alone is the compatibility boundary. Every version is folded into a single
// comparable integer key: major*100 + minor.
// ---------------------------------------------------------------------------------------

// First "X.Y" (or "X.Y.Z", patch ignored) pair in a string -> integer key, or null.
// "3.11.4" -> 311, "3.9" -> 309, "lts" / "3" (no minor) -> null (ambiguous, not a real pin).
function parseVersionKey(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/(\d+)\.(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
}

// pyproject.toml "requires-python" PEP 440 specifier -> { min, max, exact } (all integer keys,
// max exclusive) or null. Supports >=, <, ~= (compatible release, pinned to the same major),
// ==X.Y(.*) (exact minor pin), and a bare "X.Y".
function parseRequiresPythonRange(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const str = s.trim();
  const exact = str.match(/^==\s*(\d+)\.(\d+)(?:\.\*)?$/);
  if (exact) {
    const k = parseInt(exact[1], 10) * 100 + parseInt(exact[2], 10);
    return { min: null, max: null, exact: k };
  }
  const compat = str.match(/~=\s*(\d+)\.(\d+)/);
  if (compat) {
    const minK = parseInt(compat[1], 10) * 100 + parseInt(compat[2], 10);
    return { min: minK, max: parseInt(compat[1], 10) * 100 + parseInt(compat[2], 10) + 1, exact: null };
  }
  const ge = str.match(/>=\s*(\d+)\.(\d+)/);
  const lt = str.match(/<\s*(\d+)\.(\d+)/);
  if (ge) {
    const minK = parseInt(ge[1], 10) * 100 + parseInt(ge[2], 10);
    const maxK = lt ? parseInt(lt[1], 10) * 100 + parseInt(lt[2], 10) : null;
    return { min: minK, max: maxK, exact: null };
  }
  const bare = str.match(/^(\d+)\.(\d+)$/);
  if (bare) {
    const k = parseInt(bare[1], 10) * 100 + parseInt(bare[2], 10);
    return { min: null, max: null, exact: k };
  }
  return null;
}

function keySatisfiesRange(key, range) {
  if (key == null || !range) return true;
  if (range.exact != null) return key === range.exact;
  if (range.min != null && key < range.min) return false;
  if (range.max != null && key >= range.max) return false;
  return true;
}

function readPythonVersionFile(rootDir) {
  const p = path.join(rootDir, '.python-version');
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8').trim().split('\n')[0].trim();
  return { raw, key: parseVersionKey(raw) };
}

// Hand-written TOML extraction, deliberately narrow: only the "requires-python" key, anywhere
// in the file (PEP 621 requires it under [project], but a single targeted regex is correct and
// avoids pulling in a TOML parser dependency, matching this lane's zero-npm-dependency
// discipline on every prior from-scratch build). Verified against docs.python.org/packaging's
// own pyproject.toml spec page before writing this, not assumed from training knowledge.
function readPyprojectRequiresPython(rootDir) {
  const p = path.join(rootDir, 'pyproject.toml');
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  const m = text.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m);
  if (!m) return null;
  return { raw: m[1], range: parseRequiresPythonRange(m[1]) };
}

const DEFAULT_EXCLUDE_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build']);
function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir)) {
    if (DEFAULT_EXCLUDE_DIRS.has(e)) continue;
    const p = path.join(dir, e);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Every "FROM python:<tag>" line in every Dockerfile under rootDir. A tag with no minor
// component ("python:3", "python:latest", "python:3-slim") is ambiguous and skipped — the
// same "unversioned alias" skip nodedrift-ci applies to "node:lts".
function findDockerfilePins(rootDir) {
  const pins = [];
  for (const fsPath of walk(rootDir)) {
    const base = path.basename(fsPath);
    if (!/^Dockerfile(\..+)?$/.test(base)) continue;
    const text = fs.readFileSync(fsPath, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*FROM\s+python:([^\s]+)/i);
      if (!m) continue;
      const tag = m[1];
      const key = parseVersionKey(tag);
      if (key == null) continue;
      pins.push({ source: `${path.relative(rootDir, fsPath)}:${i + 1}`, raw: tag, key });
    }
  }
  return pins;
}

// Every "python-version:" declaration in every .github/workflows/*.yml(.yaml) file (the key
// actions/setup-python reads). Supports a scalar value and both inline (`['3.9', '3.11']`) and
// block (`- '3.9'`) arrays. A matrix (more than one distinct value declared together) is
// reported but never compared — testing multiple Python versions on purpose is not drift.
function findWorkflowPins(rootDir) {
  const pins = [];
  const wfDir = path.join(rootDir, '.github', 'workflows');
  if (!fs.existsSync(wfDir)) return pins;
  for (const e of fs.readdirSync(wfDir)) {
    if (!/\.ya?ml$/i.test(e)) continue;
    const fsPath = path.join(wfDir, e);
    const lines = fs.readFileSync(fsPath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)python-version:\s*(.*)$/);
      if (!m) continue;
      const indent = m[1].length;
      const rest = m[2].trim();
      let values = [];
      if (rest.startsWith('[')) {
        const inline = rest.match(/\[([^\]]*)\]/);
        if (inline) values = inline[1].split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, ''));
      } else if (rest) {
        values = [rest.replace(/^['"]|['"]$/g, '')];
      } else {
        let j = i + 1;
        while (j < lines.length) {
          const bm = lines[j].match(/^(\s*)-\s*(.+)$/);
          if (!bm || bm[1].length <= indent) break;
          values.push(bm[2].trim().replace(/^['"]|['"]$/g, ''));
          j++;
        }
      }
      if (!values.length) continue;
      const loc = `${path.relative(rootDir, fsPath)}:${i + 1}`;
      if (values.length > 1) {
        pins.push({ source: loc, raw: values.join(','), key: null, matrix: true, values });
      } else {
        const key = parseVersionKey(values[0]);
        if (key != null) pins.push({ source: loc, raw: values[0], key });
      }
    }
  }
  return pins;
}

// ---------------------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------------------
function buildReport(rootDir, opts) {
  opts = opts || {};
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new ConfigError(`${rootDir} is not a directory`);
  }
  const pythonVersion = readPythonVersionFile(rootDir);
  const requiresPython = readPyprojectRequiresPython(rootDir);
  const pins = [];
  if (pythonVersion && pythonVersion.key != null) {
    pins.push({ source: '.python-version', raw: pythonVersion.raw, key: pythonVersion.key });
  }

  const pro = !!opts.pro;
  let matrixSources = [];
  if (pro) {
    pins.push(...findDockerfilePins(rootDir));
    const wfPins = findWorkflowPins(rootDir);
    matrixSources = wfPins.filter((p) => p.matrix).map((p) => p.source);
    pins.push(...wfPins.filter((p) => !p.matrix));
  }

  const findings = [];

  const distinctKeys = new Set(pins.map((p) => p.key));
  if (distinctKeys.size > 1) {
    findings.push({
      rule: 'pinMismatch',
      message: `Pinned Python versions disagree: ${pins.map((p) => `${p.source}=${p.raw}`).join(', ')}`,
      pins,
    });
  }

  if (requiresPython && requiresPython.range) {
    for (const p of pins) {
      if (!keySatisfiesRange(p.key, requiresPython.range)) {
        findings.push({
          rule: 'requiresPythonMismatch',
          message: `${p.source} pins Python ${p.raw}, which does not satisfy pyproject.toml requires-python "${requiresPython.raw}"`,
          source: p.source,
          raw: p.raw,
          requiresPython: requiresPython.raw,
        });
      }
    }
  }

  return {
    breach: findings.length > 0,
    pro,
    sources: { pythonVersion: pythonVersion && pythonVersion.raw, requiresPython: requiresPython && requiresPython.raw, pins },
    matrixSources,
    findings,
  };
}

class ConfigError extends Error {}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

function printHumanReport(result) {
  console.log(`pydrift-ci — mode: ${result.pro ? 'Pro (python-version + requires-python + Dockerfile + CI workflows)' : 'free (python-version + requires-python only)'}`);
  if (result.matrixSources.length) {
    console.log(`  (skipped as intentional matrix testing, not drift: ${result.matrixSources.join(', ')})`);
  }
  if (!result.findings.length) {
    console.log('  no drift found.');
  } else {
    for (const f of result.findings) console.log(`  DRIFT  [${f.rule}]  ${f.message}`);
  }
  if (!result.pro) {
    console.log('  (free mode checked .python-version + pyproject.toml only — Pro also checks every Dockerfile and GitHub Actions workflow: https://pydrift-ci.madeforthisday.com)');
  }
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];

  if (args.help || !command) {
    console.log('Usage: node cli.js check [--dir <path>] [--json]');
    process.exit(command ? 0 : 2);
    return;
  }
  if (command !== 'check') {
    console.error(`Unknown command "${command}". Only "check" is supported.`);
    process.exit(2);
    return;
  }

  const dir = args.dir ? path.resolve(process.cwd(), args.dir) : process.cwd();
  let result;
  try {
    result = buildReport(dir, { pro: hasPro() });
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`pydrift-ci config error: ${e.message}`);
      process.exit(2);
      return;
    }
    throw e;
  }

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHumanReport(result);

  process.exit(result.breach ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  buildReport, verifyLicense, verifyLicenseWith, parseVersionKey, parseRequiresPythonRange,
  keySatisfiesRange, findDockerfilePins, findWorkflowPins, readPythonVersionFile,
  readPyprojectRequiresPython,
};
