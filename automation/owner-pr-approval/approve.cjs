// Central owner approval policy. GitHub operations go through the gh CLI.
const { execFileSync } = require('node:child_process');
const config = require('./config.json');

const SNAPSHOT = `query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      state isDraft headRefOid baseRefName reviewDecision isInMergeQueue
      author { login }
      timelineItems(first:1,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT]) {
        nodes { __typename }
      }
    }
  }
}`;

function gh(args, payload) {
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8',
    input: payload === undefined ? undefined : JSON.stringify(payload),
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

function pages(api, endpoint) {
  return api(['api', '--paginate', '--slurp', endpoint]).flat();
}

function snapshot(api, repository, number) {
  const [owner, repo] = repository.split('/');
  const response = api(['api', 'graphql', '-f', `query=${SNAPSHOT}`,
    '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${number}`]);
  if (response.errors) throw new Error(JSON.stringify(response.errors));
  const pr = response.data?.repository?.pullRequest;
  if (!pr) throw new Error(`Cannot inspect ${repository}#${number}`);
  return pr;
}

function eligibility(pr, reviews, target, policy = config) {
  if (pr.author?.login !== policy.author) return 'different author';
  if (pr.state !== 'OPEN' || pr.isDraft) return 'closed or draft';
  if (pr.baseRefName !== target.base) return 'different base';
  if (pr.isInMergeQueue) return 'already in merge queue';
  if (pr.timelineItems.nodes.length) return 'previously entered merge queue';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested';
  if (reviews.some(review => review.user?.login === policy.bot &&
      ['APPROVED', 'DISMISSED', 'PENDING', 'CHANGES_REQUESTED'].includes(review.state))) {
    return 'bot already reviewed, including dismissed approvals';
  }
  return null;
}

function greenRun(run, sha, workflow) {
  return run && run.head_sha === sha && run.event === 'pull_request' &&
    run.path === `.github/workflows/${workflow}` &&
    run.status === 'completed' && run.conclusion === 'success';
}

function checkCi(api, target, sha) {
  if (!Array.isArray(target.workflows) || target.workflows.length === 0) {
    throw new Error('At least one required CI workflow must be configured');
  }
  for (const workflow of target.workflows) {
    const result = api(['api', '--method', 'GET',
      `repos/${target.name}/actions/workflows/${workflow}/runs`,
      '-f', `head_sha=${sha}`, '-f', 'event=pull_request', '-f', 'per_page=100']);
    // A new run or rerun in progress must replace an earlier green result.
    const latest = result.workflow_runs.reduce((best, run) =>
      !best || run.id > best.id ? run : best, null);
    if (!greenRun(latest, sha, workflow)) return `${workflow} is not green on current head`;
  }
  return null;
}

function inspect(api, target, number, policy) {
  const pr = snapshot(api, target.name, number);
  const reviews = pages(api, `repos/${target.name}/pulls/${number}/reviews?per_page=100`);
  return { pr, reason: eligibility(pr, reviews, target, policy) };
}

function approveOne({ api = gh, target, number, apply = false, policy = config, log = console.log }) {
  const label = `${target.name}#${number}`;
  const first = inspect(api, target, number, policy);
  let reason = first.reason || checkCi(api, target, first.pr.headRefOid);
  if (reason) { log(`${label}: skip, ${reason}`); return 'skipped'; }
  if (!apply) { log(`${label}: would approve ${first.pr.headRefOid}`); return 'eligible'; }

  // Refresh the head, review history, queue history and CI immediately before writing.
  const fresh = inspect(api, target, number, policy);
  reason = fresh.reason || (fresh.pr.headRefOid !== first.pr.headRefOid && 'head changed') ||
    checkCi(api, target, fresh.pr.headRefOid);
  if (reason) { log(`${label}: skip, ${reason}`); return 'skipped'; }
  const review = api(['api', '--method', 'POST',
    `repos/${target.name}/pulls/${number}/reviews`, '--input', '-'], {
    commit_id: fresh.pr.headRefOid,
    event: 'APPROVE',
    body: 'Automatic owner approval by Illegal Bot: author nahime0, CI passed on this commit. '
      + 'This is an automation policy approval, not a human code review. '
      + 'It will not be automatically renewed after dismissal or a later push.',
  });
  if (review.state !== 'APPROVED' || review.commit_id !== fresh.pr.headRefOid ||
      review.user?.login !== policy.bot) throw new Error(`Unexpected approval result for ${label}`);
  log(`${label}: approved ${fresh.pr.headRefOid}, review ${review.id}`);
  return 'approved';
}

function run({ api = gh, policy = config, apply = false, number = '', log = console.log } = {}) {
  if (number && !/^[1-9][0-9]*$/.test(number)) throw new Error('PR number must be a positive integer');
  let failed = false;
  for (const target of policy.repositories) {
    const numbers = number ? [Number(number)] : pages(api,
      `repos/${target.name}/pulls?state=open&base=${encodeURIComponent(target.base)}&per_page=100`)
      .filter(pr => pr.user?.login === policy.author && !pr.draft).map(pr => pr.number);
    for (const pr of numbers) {
      try {
        approveOne({ api, target, number: pr, policy, apply, log });
      } catch (error) {
        // Do not dump subprocess buffers, request headers or credentials into public logs.
        log(`${target.name}#${pr}: failed, ${error.status ? `gh exit ${error.status}` : error.message}`);
        failed = true;
      }
    }
  }
  if (failed) throw new Error('At least one PR could not be processed');
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--apply')) throw new Error('Only --apply is supported');
    run({ apply: args.includes('--apply'), number: process.env.PR_NUMBER || '' });
  } catch (error) {
    console.error(error.status ? `gh failed with exit ${error.status}` : error.message);
    process.exitCode = 1;
  }
}

module.exports = { eligibility, greenRun, approveOne, run };
