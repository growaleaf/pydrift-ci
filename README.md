# pydrift-ci

Fail CI when your Python version claims disagree with each other.

A project can declare its target Python version in four different places — `.python-version`
(pyenv), `pyproject.toml`'s `requires-python`, a `Dockerfile`'s `FROM python:X.Y`, and a GitHub
Actions workflow's `python-version:` — each edited by a different person at a different time.
They drift silently, and the bug that surfaces is "works in CI, breaks in the Docker image" (or
the reverse), discovered in production, not in review. Same shape as this lane's `nodedrift-ci`
for the Node.js ecosystem, ported to Python's own four files.

```
$ npx github:growaleaf/pydrift-ci check
pydrift-ci — mode: free (python-version + requires-python only)
  no drift found.
  (free mode checked .python-version + pyproject.toml only — Pro also checks every Dockerfile
  and GitHub Actions workflow: https://pydrift-ci.madeforthisday.com)

$ PYDRIFT_KEY=... npx github:growaleaf/pydrift-ci check
pydrift-ci — mode: Pro (python-version + requires-python + Dockerfile + CI workflows)
  DRIFT  [pinMismatch]  Pinned Python versions disagree: .python-version=3.11.4, Dockerfile:1=3.9-slim, .github/workflows/ci.yml:5=3.11
  DRIFT  [requiresPythonMismatch]  .python-version pins Python 3.11.4, which does not satisfy pyproject.toml requires-python ">=3.9,<3.11"
```

A deliberate CI version matrix (`python-version: ['3.9', '3.10', '3.11']`, used to test
multiple Python versions on purpose) is detected and reported as skipped — it is never treated
as drift.

## Install

No npm account needed — install straight from the GitHub repo:

```
npm install github:growaleaf/pydrift-ci
```

Or run it without installing:

```
npx github:growaleaf/pydrift-ci check
```

## Usage

```
node cli.js check [--dir <path>] [--json]
```

| Exit code | Meaning |
|---|---|
| 0 | no drift found |
| 1 | a drift finding exists — fail the build on this |
| 2 | configuration error — `--dir` does not exist |

`--json` writes the full report (every source checked, every finding, the skipped-matrix
list) to stdout, suited to a PR-comment bot or a lint-results artifact.

## Free vs. Pro

**Free, no key needed:** compares `.python-version` against `pyproject.toml`'s
`requires-python`. Useful on its own for a project with no Docker image and no CI-declared
Python version.

**Pro ($9, one time):** also scans every `Dockerfile` (any file matching `Dockerfile*`,
anywhere in the repo) and every `.github/workflows/*.yml` for a `python-version:` declaration,
and cross-checks every source against every other source — this is where the real bugs are,
since the Dockerfile and the CI workflow are usually the two files furthest from active
editing.

The license key is checked **offline** — an ECDSA-signed token verified locally; the CLI
makes no network call to check it, ever, and reads neither your source files nor your
repository name over the network at any point.

```
export PYDRIFT_KEY=<your key>       # CI secret
# or, on your own machine:
mkdir -p ~/.pydrift && echo "<your key>" > ~/.pydrift/license
```

Buy a key: https://pydrift-ci.madeforthisday.com (one-time purchase, no subscription).

## How this differs from an existing tool you may already know

A search of the npm registry and GitHub for a tool that cross-checks `.python-version` +
`pyproject.toml`'s `requires-python` + `Dockerfile` + CI workflow `python-version` declarations
together turned up nothing with that exact scope as of 2026-10-29 — this is a narrow, specific
gap, not a crowded one. Linters like `ruff` and `mypy` check code against a target version;
they do not cross-check the project's own version-declaration files against each other.

## Source

Source is readable here before you buy. The free tier works as shipped; the Pro tier needs
a key (see `LICENSE`).
