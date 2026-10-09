# Publishing to npm

The three public packages live under the `@ourointelligence` npm organisation and are released together from this monorepo with [changesets](https://github.com/changesets/changesets) and `pnpm publish`.

| Package | Directory |
| --- | --- |
| `@ourointelligence/sdk` | `packages/sdk` |
| `@ourointelligence/source-hyperliquid` | `packages/source-hyperliquid` |
| `@ourointelligence/executor-paper` | `packages/executor-paper` |

The three are `linked` in `.changeset/config.json`, so they always share one version number. The examples are private and never published.

## One-time setup

```bash
npm login                      # an account that is a member of the ourointelligence npm org
npm whoami                     # prints your user name
```

Publishing needs the `publish` permission on the org and, if your account has two-factor authentication set to "authorization and publishing", a one-time password at publish time.

## Bumping versions

1. Make your changes on a branch and add a changeset describing them. One changeset per logical change is fine:

   ```bash
   pnpm changeset
   ```

   The prompt asks which packages changed and whether the bump is `patch`, `minor` or `major`. Because the packages are linked, the highest bump chosen applies to all three. Commit the generated `.changeset/*.md` file with the change.

2. When you are ready to release, apply the pending changesets. This rewrites the `version` fields, updates the `CHANGELOG.md` files and deletes the consumed changeset files:

   ```bash
   pnpm version                 # runs: changeset version
   pnpm install                 # refresh the lockfile for the new versions
   git add -A && git commit -m "release @ourointelligence <new version>"
   ```

## Build, test, inspect

Always publish from a clean build that passed the suite:

```bash
pnpm -r --filter "./packages/**" exec rm -rf dist
pnpm build
pnpm typecheck
pnpm test
```

Inspect what will be uploaded before it leaves your machine. Only `dist/`, `README.md`, `LICENSE` and `package.json` may appear; no `.env`, no `.ouro/`, no sources or tests:

```bash
for p in sdk source-hyperliquid executor-paper; do
  (cd packages/$p && pnpm pack --pack-destination /tmp/ouro-pack)
done
for t in /tmp/ouro-pack/*.tgz; do echo "== $t"; tar -tzf "$t" | sort; done
```

`isolated-vm` must stay an `optionalDependency` of the SDK. Check that the package still installs and runs without it (the sandbox falls back to a worker thread):

```bash
mkdir /tmp/ouro-nooptional && cd /tmp/ouro-nooptional && npm init -y
npm install --no-optional /tmp/ouro-pack/ourointelligence-sdk-0.1.0.tgz
ls node_modules/isolated-vm   # must not exist
npx ouro --version
```

## Publish

Publish in dependency order so that the plugins never reference an SDK version the registry does not have yet. `pnpm publish -r` does this ordering itself and rewrites `workspace:^` ranges to the real version:

```bash
pnpm publish -r --access public
```

If two-factor authentication is enforced, pnpm prompts for the one-time password; pass it explicitly with `--otp <code>` when the prompt is not available (for example from a script). A publish that fails halfway can be resumed with the same command; packages whose version is already on the registry are skipped.

Then tag and push:

```bash
git tag v<new version>
git push --follow-tags
```

## Verify from outside the repo

```bash
mkdir /tmp/ouro-verify && cd /tmp/ouro-verify && npm init -y
npm i @ourointelligence/sdk @ourointelligence/source-hyperliquid @ourointelligence/executor-paper
npx ouro --help
```

and confirm the three package pages show the new version:

- https://www.npmjs.com/package/@ourointelligence/sdk
- https://www.npmjs.com/package/@ourointelligence/source-hyperliquid
- https://www.npmjs.com/package/@ourointelligence/executor-paper

## Fixing a bad release

npm allows `npm unpublish <pkg>@<version>` within 72 hours of publishing, and `npm deprecate <pkg>@<version> "<message>"` at any time. Prefer publishing a patch release with a changeset over unpublishing; a version number, once published, cannot be reused.
