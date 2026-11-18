# Owner PR approval

The central `Owner PR approval` workflow scans only `nahime0` pull requests on
`illegalstudio/elephc`, targeting `main`. It uses the existing Illegal Bot App
(`illegal-studio[bot]`) and never checks out or executes candidate PR code.

It approves an open, non-draft PR only when the latest `pull_request` run of
`ci.yml` completed successfully on the current head SHA. That workflow includes
elephc's three required CI aggregate checks. Missing, running, failed, cancelled
and skipped workflow runs do not qualify. A newer run supersedes an older green
result. Active change requests prevent approval.

The bot approves each head SHA of a PR at most once, including approvals later
marked `DISMISSED`. A push to a new head can receive a fresh approval after CI
passes there. A pending bot review or a bot request for changes blocks approval.
The bot skips PRs currently in the merge queue. For PRs that previously entered
the queue, it only renews an earlier bot approval on a different head SHA.

The script rechecks eligibility and CI before writing and submits the review for
the exact inspected commit. GitHub remains responsible for dismissing stale
approvals and enforcing merge requirements. No merge, enqueue or bypass API is
called by this automation. An existing auto-merge request may advance to the queue
when the approval satisfies the last requirement.

## Operation

The workflow is scheduled every five minutes, offset from the top of the hour.
GitHub can delay scheduled runs; this is polling, not an immediate webhook.
Scheduled writes require the repository variable
`OWNER_PR_AUTO_APPROVAL_ENABLED=true`. Without it, scheduled jobs are skipped.

Manual runs support an optional elephc PR number and default to a dry run:

```bash
gh workflow run owner-pr-approval.yml --repo illegalstudio/.github \
  -f pull_request=2401 -f dry_run=true
```

Set `dry_run=false` to post approvals. Manual runs use exactly the same policy and
require the same CI, review and merge queue checks.

`ILLEGAL_BOT_APP_ID` and `ILLEGAL_BOT_PRIVATE_KEY` are inherited organization
secrets. Each run mints a short-lived installation token limited to elephc with
pull requests write, Actions read and contents read. The token is revoked by the
token action when the job ends. The workflow token only reads the central repo.

Run local, credential-free tests with:

```bash
node --test automation/owner-pr-approval/approve.test.cjs
```

`config.json` is the repository and author allowlist. Keep its repository list
aligned with the token action's `repositories` input when extending the scope.
