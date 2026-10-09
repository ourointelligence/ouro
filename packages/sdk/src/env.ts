import fs from 'node:fs';
import path from 'node:path';

export type LoadEnvOptions = {
  /** Directory whose `.env` is read first. Default: `process.cwd()`. */
  cwd?: string;
  /** Replace variables that are already set in the environment. Default: false. */
  override?: boolean;
  /** File name to look for. Default: `.env`. */
  file?: string;
};

/**
 * Parse the body of a `.env` file. Supports `KEY=value`, `export KEY=value`, blank lines, `#` comments,
 * single and double quotes (double quotes expand `\n`), and trailing ` # comments` on unquoted values.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!.trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Walk up from `start` to the nearest directory that looks like a repository root. */
export function findRepoRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    for (const marker of ['pnpm-workspace.yaml', '.git']) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, 'utf8')).workspaces) return dir;
      } catch {
        /* not a workspace manifest */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Load `.env` from the current working directory and from the repository root (in that order) into
 * `process.env`. Variables already set in the shell are never replaced unless `override` is true, and
 * the working-directory file wins over the root file. Returns the paths that were read.
 */
export function loadEnv(opts: LoadEnvOptions = {}): string[] {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const file = opts.file ?? '.env';
  const candidates = [path.join(cwd, file)];
  const root = findRepoRoot(cwd);
  if (root && root !== cwd) candidates.push(path.join(root, file));
  const loaded: string[] = [];
  for (const p of candidates) {
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(parseEnv(text))) {
      if (opts.override || process.env[k] === undefined) process.env[k] = v;
    }
    loaded.push(p);
  }
  return loaded;
}
