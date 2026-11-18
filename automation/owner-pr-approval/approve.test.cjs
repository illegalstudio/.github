const { test } = require('node:test');
const assert = require('node:assert/strict');
const { eligibility, greenRun, approveOne, run } = require('./approve.cjs');
const policy = require('./config.json');
const target = policy.repositories[0];
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const queueHistory = { nodes: [{ __typename: 'AddedToMergeQueueEvent' }] };

function botReview(state, commit_id = sha) {
  return { user: { login: policy.bot }, state, commit_id };
}

function pullRequest(overrides = {}) {
  return {
    author: { login: 'nahime0' }, state: 'OPEN', isDraft: false,
    baseRefName: 'main', headRefOid: sha, isInMergeQueue: false,
    reviewDecision: 'REVIEW_REQUIRED', timelineItems: { nodes: [] }, ...overrides,
  };
}

function workflow(overrides = {}) {
  return {
    id: 100, head_sha: sha, event: 'pull_request',
    path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', ...overrides,
  };
}

function fixture({ snapshots = [pullRequest()], reviews = [], runs = [workflow()] } = {}) {
  const writes = [];
  let index = 0;
  function api(args, payload) {
    if (args.includes('graphql')) {
      const pr = snapshots[Math.min(index++, snapshots.length - 1)];
      return { data: { repository: { pullRequest: pr } } };
    }
    if (args.includes('POST')) {
      writes.push(payload);
      return { state: 'APPROVED', commit_id: payload.commit_id,
        user: { login: policy.bot }, id: 123 };
    }
    if (args.some(arg => arg.endsWith('/reviews?per_page=100'))) return [reviews];
    if (args.some(arg => arg.endsWith('/actions/workflows/ci.yml/runs'))) {
      return { workflow_runs: typeof runs === 'function' ? runs() : runs };
    }
    if (args.some(arg => arg.includes('/pulls?'))) {
      return [[{ number: 2401, user: { login: 'nahime0' }, draft: false },
        { number: 2402, user: { login: 'someone-else' }, draft: false }]];
    }
    throw new Error(`Unexpected call ${JSON.stringify(args)}`);
  }
  return { api, writes, log() {}, target, number: 2401, policy };
}

test('only an open owner PR targeting main is eligible', () => {
  assert.equal(eligibility(pullRequest(), [], target), null);
  for (const change of [{ author: { login: 'other' } }, { state: 'CLOSED' },
    { isDraft: true }, { baseRefName: 'release' }, { reviewDecision: 'CHANGES_REQUESTED' }]) {
    assert.ok(eligibility(pullRequest(change), [], target));
  }
});

test('current queue membership blocks renewal even on a new head', () => {
  const input = fixture({
    snapshots: [pullRequest({ isInMergeQueue: true })],
    reviews: [botReview('DISMISSED', otherSha)],
  });
  assert.equal(approveOne({ ...input, apply: true }), 'skipped');
  assert.equal(input.writes.length, 0);
});

test('historical queue membership allows renewal of an earlier bot approval', () => {
  const snapshots = [pullRequest({ timelineItems: queueHistory })];
  const firstApproval = fixture({ snapshots });
  assert.equal(approveOne({ ...firstApproval, apply: true }), 'skipped');
  assert.equal(firstApproval.writes.length, 0);

  const renewal = fixture({ snapshots, reviews: [botReview('DISMISSED', otherSha)] });
  assert.equal(approveOne({ ...renewal, apply: true }), 'approved');
  assert.equal(renewal.writes[0].commit_id, sha);
});

test('a bot approval or dismissal on the current head prevents duplicate approval', () => {
  for (const state of ['APPROVED', 'DISMISSED']) {
    const input = fixture({ reviews: [botReview(state)] });
    assert.equal(approveOne({ ...input, apply: true }), 'skipped');
    assert.equal(input.writes.length, 0);
  }
});

test('a pending bot review or change request blocks approval on a new head', () => {
  for (const state of ['PENDING', 'CHANGES_REQUESTED']) {
    const input = fixture({ reviews: [botReview(state, otherSha)] });
    assert.equal(approveOne({ ...input, apply: true }), 'skipped');
    assert.equal(input.writes.length, 0);
  }
  assert.equal(eligibility(pullRequest(), [
    botReview('COMMENTED'),
    { user: { login: 'other' }, state: 'APPROVED' },
  ], target), null);
});

test('approval is renewed once the new head has a successful CI run', () => {
  for (const state of ['APPROVED', 'DISMISSED']) {
    const reviews = [botReview(state, otherSha)];
    let runs = [workflow({ head_sha: otherSha })];
    const input = fixture({ reviews, runs: () => runs });

    assert.equal(approveOne({ ...input, apply: true }), 'skipped');
    runs = [workflow({ status: 'in_progress', conclusion: null })];
    assert.equal(approveOne({ ...input, apply: true }), 'skipped');
    runs = [workflow({ conclusion: 'failure' })];
    assert.equal(approveOne({ ...input, apply: true }), 'skipped');
    assert.equal(input.writes.length, 0);

    runs = [workflow()];
    assert.equal(approveOne({ ...input, apply: true }), 'approved');
    assert.equal(input.writes[0].commit_id, sha);

    reviews.push(botReview('APPROVED'));
    assert.equal(approveOne({ ...input, apply: true }), 'skipped');
    assert.equal(input.writes.length, 1);
  }
});

test('CI must succeed for the exact head, workflow and PR event', () => {
  assert.ok(greenRun(workflow(), sha, 'ci.yml'));
  for (const change of [{ head_sha: otherSha }, { event: 'push' },
    { path: '.github/workflows/other.yml' }, { status: 'in_progress' },
    { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' }]) {
    assert.ok(!greenRun(workflow(change), sha, 'ci.yml'));
  }
  assert.ok(!greenRun(null, sha, 'ci.yml'));
});

test('a missing run or newer unfinished run overrides an old green run', () => {
  for (const runs of [[], [workflow(), workflow({ id: 101, status: 'in_progress', conclusion: null })]]) {
    const input = fixture({ runs });
    assert.equal(approveOne({ ...input, apply: true }), 'skipped');
    assert.equal(input.writes.length, 0);
  }
});

test('dry run reports eligibility without posting a review', () => {
  const input = fixture();
  assert.equal(approveOne(input), 'eligible');
  assert.equal(input.writes.length, 0);
});

test('approval is bound to the inspected exact commit', () => {
  const input = fixture();
  assert.equal(approveOne({ ...input, apply: true }), 'approved');
  assert.equal(input.writes.length, 1);
  assert.equal(input.writes[0].commit_id, sha);
  assert.equal(input.writes[0].event, 'APPROVE');
});

test('a head change or queue entry before writing aborts approval', () => {
  for (const change of [{ headRefOid: otherSha }, { isInMergeQueue: true },
    { timelineItems: queueHistory }]) {
    const input = fixture({ snapshots: [pullRequest(), pullRequest(change)] });
    assert.equal(approveOne({ ...input, apply: true }), 'skipped');
    assert.equal(input.writes.length, 0);
  }
});

test('a CI rerun starting before the write prevents approval', () => {
  let reads = 0;
  const input = fixture({ runs: () => ++reads === 1 ? [workflow()] :
    [workflow({ status: 'in_progress', conclusion: null })] });
  assert.equal(approveOne({ ...input, apply: true }), 'skipped');
  assert.equal(input.writes.length, 0);
});

test('a bot approval appearing during inspection prevents a duplicate', () => {
  const input = fixture();
  let reads = 0;
  const api = (args, payload) => {
    if (args.some(arg => arg.endsWith('/reviews?per_page=100')) && ++reads === 2) {
      return [[botReview('APPROVED')]];
    }
    return input.api(args, payload);
  };
  assert.equal(approveOne({ ...input, api, apply: true }), 'skipped');
  assert.equal(input.writes.length, 0);
});

test('an empty CI allowlist cannot approve a PR', () => {
  const input = fixture();
  assert.throws(() => approveOne({ ...input, target: { ...target, workflows: [] }, apply: true }));
  assert.equal(input.writes.length, 0);
});

test('an unreadable queue history fails before approval', () => {
  const input = fixture({ snapshots: [pullRequest({ timelineItems: null })] });
  assert.throws(() => approveOne({ ...input, apply: true }));
  assert.equal(input.writes.length, 0);
});

test('scan filters other authors before inspecting or approving', () => {
  const input = fixture();
  run({ ...input, apply: true });
  assert.equal(input.writes.length, 1);
});

test('manual selection rejects shell syntax and invalid PR numbers', () => {
  for (const number of ['0', '-1', '2401;echo token', 'all', '1.5']) {
    assert.throws(() => run({ ...fixture(), number }));
  }
});
