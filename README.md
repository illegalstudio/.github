# illegalstudio/.github

Shared GitHub automation for Illegal Studio repositories.

## Central workflows

[`Owner PR approval`](automation/owner-pr-approval) uses Illegal Bot to approve
eligible `nahime0` PRs on elephc after CI passes. It polls every five minutes when
enabled and never automatically repeats an earlier approval, including one
dismissed after a push. No workflow needs to be installed in the target repo.

## Actions

| Action | Description |
|---|---|
| [`actions/subtree-mirror`](actions/subtree-mirror) | Publishes one directory of a repository to its own read-only mirror repository. |

Reference an action with a full commit SHA:

```yaml
uses: illegalstudio/.github/actions/subtree-mirror@<commit-sha>
```

## Organization defaults

GitHub uses community health files at the root of this repository (such as `CONTRIBUTING.md` or `SECURITY.md`) as defaults for every organization repository that has none. Add such a file here only when it should apply to all of them.
