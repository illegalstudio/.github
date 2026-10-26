# Subtree mirror

Publishes one directory of a repository to its own read-only mirror repository on GitHub, so a project can live in a monorepo and still have a standalone public repository.

It authenticates as a GitHub App with a token limited to the one mirror, never force-pushes, and refuses to publish over a commit that was made directly on the mirror.

## Usage

```yaml
on:
  push:
    branches: [main]
    paths: [showcases/doom/**]

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0          # the split walks the directory's whole history
          persist-credentials: false

      - uses: illegalstudio/.github/actions/subtree-mirror@<commit-sha> # pin a full SHA
        with:
          prefix: showcases/doom
          repository: getelephc/doom
          push: true
          app-id: ${{ secrets.ELEPHC_BOT_APP_ID }}
          private-key: ${{ secrets.ELEPHC_BOT_PRIVATE_KEY }}
```

Without `push: true` the action is a dry run: it checks the split and needs no credentials, which suits pull requests.

## Inputs

| Input | Default | Description |
|---|---|---|
| `prefix` | required | Directory to publish, relative to the repository root. |
| `repository` | required | Mirror repository as `OWNER/NAME`. It must exist; an empty repository is fine. |
| `history` | `preserve` | `preserve` or `flatten`, see below. |
| `message` | source commit | Message of a `flatten` commit. The default names the source repository and commit. |
| `push` | `false` | `true` publishes; anything else is a dry run. |
| `app-id` | | ID of a GitHub App installed on the mirror's owner with contents write. Required to push. |
| `private-key` | | Private key of that App. Required to push. |
| `workflows` | `auto` | Also request workflows write, needed when the push touches `.github/workflows`. `auto` requests it when the published directory contains `.github/workflows`. |

## Outputs

| Output | Description |
|---|---|
| `sha` | The published commit; on a dry run, the commit (`preserve`) or tree (`flatten`) that would be published. |
| `published` | `true` when the mirror's `main` moved. |

## History modes

- **`preserve`** publishes `git subtree split` of the directory: its own history, with the original authors and messages. It publishes only when the mirror's `main` is an ancestor of the split.
- **`flatten`** adds one commit per publish, authored by the App's bot (`<slug>[bot]`), whose tree is the directory and whose parent is the mirror's `main`. It publishes only when that `main` was made by the bot or by an earlier `preserve` publish.

Choose the mode once per mirror. A `preserve` mirror can switch to `flatten`; the reverse would rewrite the mirror's history, so it is refused.

## Guarantees and requirements

- The source is the checked-out `HEAD`, so uncommitted files are never published. The checkout needs the full history (`fetch-depth: 0`).
- The mirror takes no direct commits: a commit made there stops the next publish with an error instead of being overwritten. Bring the change into the source directory, then publish again.
- The token travels only through environment-only Git configuration, never in a URL or a file, and the App token is revoked when the job ends.
- A mirrored directory should work as a repository root: its README, license and `.github/workflows` belong inside it. Those workflows are inert in the source repository and run in the mirror.
- Pin the action to a full commit SHA.

## Tests

```bash
bash actions/subtree-mirror/test.sh
```

The tests publish a synthetic repository to local bare mirrors, so they need no network or token.
