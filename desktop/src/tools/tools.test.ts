import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApprovalRequired,
  CommandSafetyError,
  ToolDenied,
  createCoreToolRegistration,
  type ApprovalDecision,
  type ApprovalDescriptor,
  type ToolPolicy,
} from './tools.js';
import { Workspace, WorkspaceError } from './workspace.js';


async function fixture(policy: ToolPolicy = 'allow') {
  const base = await mkdtemp(join(tmpdir(), 'tawx-tools-'));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  await mkdir(join(project, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(project, 'src', 'message.txt'), 'before\n');
  await writeFile(join(outside, 'secret.txt'), 'TOKEN=outside-secret\n');
  const workspace = new Workspace();
  await workspace.select(project);
  return {
    base,
    project,
    outside,
    workspace,
    tools: createCoreToolRegistration({ workspace, policy }),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

async function runGitFixture(project: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd: project, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function initializeGit(project: string): Promise<void> {
  await runGitFixture(project, ['init']);
  await runGitFixture(project, ['config', 'user.name', 'Cowork Test']);
  await runGitFixture(project, ['config', 'user.email', 'cowork@example.test']);
  await runGitFixture(project, ['add', '.']);
  await runGitFixture(project, ['commit', '-m', 'Initial']);
}

test('registers every core tool through one task-scoped interface', async () => {
  const fx = await fixture();
  try {
    assert.deepEqual(
      fx.tools.definitions.map((tool) => tool.function?.name),
      ['read_file', 'list_directory', 'update_todo', 'write_file', 'run_command', 'git_status', 'git_diff', 'git_commit'],
    );
    assert.equal(typeof fx.tools.execute, 'function');
    assert.equal(typeof fx.tools.undo, 'function');
  } finally {
    await fx.cleanup();
  }
});

test('update_todo emits ordered redacted progress without workspace or approval', async () => {
  const workspace = new Workspace();
  let approvalCalls = 0;
  let emitted: unknown;
  const tools = createCoreToolRegistration({
    workspace,
    policy: 'ask',
    enabledTools: ['update_todo'],
    approval: async () => {
      approvalCalls += 1;
      return 'deny';
    },
    onTodo: (payload) => {
      emitted = payload;
    },
  });

  const result = await tools.execute('update_todo', {
    items: [
      { id: 'inspect', content: 'Inspect the runtime', status: 'completed' },
      { id: 'implement', content: 'TOKEN=todo-secret', status: 'in_progress' },
      { id: 'verify', content: 'Verify behavior', status: 'pending' },
    ],
  });

  assert.equal(approvalCalls, 0);
  assert.deepEqual(emitted, {
    items: [
      { id: 'inspect', text: 'Inspect the runtime', status: 'completed' },
      { id: 'implement', text: 'TOKEN=[REDACTED]', status: 'in_progress' },
      { id: 'verify', text: 'Verify behavior', status: 'pending' },
    ],
  });
  assert.equal(result.content, 'Updated 3 todo items: 1 pending, 1 in progress, 1 completed.');
  assert.deepEqual(
    tools.auditRecords().map((record) => record.action),
    ['requested', 'succeeded'],
  );
  assert.doesNotMatch(JSON.stringify(tools.auditRecords()), /todo-secret/);
});

test('update_todo rejects invalid and unbounded task state', async () => {
  const workspace = new Workspace();
  const tools = createCoreToolRegistration({
    workspace,
    policy: 'allow',
    enabledTools: ['update_todo'],
  });

  await assert.rejects(() => tools.execute('update_todo', { items: [] }), /at least one todo/);
  await assert.rejects(
    () => tools.execute('update_todo', {
      items: Array.from({ length: 51 }, (_, index) => ({
        id: `todo-${index}`,
        content: 'bounded',
        status: 'pending',
      })),
    }),
    /50 todo limit/,
  );
  await assert.rejects(
    () => tools.execute('update_todo', {
      items: [
        { id: 'duplicate', content: 'one', status: 'pending' },
        { id: 'duplicate', content: 'two', status: 'completed' },
      ],
    }),
    /duplicate todo id/,
  );
  await assert.rejects(
    () => tools.execute('update_todo', {
      items: [{ id: 'failed', content: 'invalid status', status: 'failed' }],
    }),
    /status is invalid/,
  );
  await assert.rejects(
    () => tools.execute('update_todo', {
      items: [{ id: 'large', content: 'x'.repeat(2_001), status: 'pending' }],
    }),
    /content is invalid/,
  );
});

test('plan mode permits reads but denies mutations and commands', async () => {
  const fx = await fixture('plan');
  try {
    const read = await fx.tools.execute('read_file', { path: 'src/message.txt' });
    assert.equal(read.content, 'before\n');
    await initializeGit(fx.project);
    const status = await fx.tools.execute('git_status', {});
    assert.match(status.content, /##/);
    const diff = await fx.tools.execute('git_diff', {});
    assert.equal(diff.content, 'git_diff completed with no output');
    await assert.rejects(
      () => fx.tools.execute('write_file', { path: 'src/message.txt', content: 'after\n' }),
      ToolDenied,
    );
    await assert.rejects(
      () => fx.tools.execute('run_command', { command: 'printf safe' }),
      ToolDenied,
    );
    assert.equal(await readFile(join(fx.project, 'src', 'message.txt'), 'utf8'), 'before\n');
  } finally {
    await fx.cleanup();
  }
});

test('disabled tools stay denied even in allow mode', async () => {
  const fx = await fixture();
  try {
    const tools = createCoreToolRegistration({
      workspace: fx.workspace,
      policy: 'allow',
      enabledTools: ['read_file'],
    });
    assert.deepEqual(tools.definitions.map((tool) => tool.function?.name), ['read_file']);
    await assert.rejects(
      () => tools.execute('write_file', { path: 'new.txt', content: 'new' }),
      ToolDenied,
    );
  } finally {
    await fx.cleanup();
  }
});

test('ask mode exposes a redacted diff and does not write before approval', async () => {
  const fx = await fixture('ask');
  let releaseApproval!: (decision: ApprovalDecision) => void;
  let revealDescriptor!: (descriptor: ApprovalDescriptor) => void;
  const descriptorSeen = new Promise<ApprovalDescriptor>((resolve) => {
    revealDescriptor = resolve;
  });
  const decision = new Promise<ApprovalDecision>((resolve) => {
    releaseApproval = resolve;
  });
  const tools = createCoreToolRegistration({
    workspace: fx.workspace,
    policy: 'ask',
    approval: async (descriptor) => {
      revealDescriptor(descriptor);
      return decision;
    },
  });

  try {
    const pending = tools.execute('write_file', {
      path: 'src/message.txt',
      content: 'TOKEN=super-secret\nafter\n',
    });
    const descriptor = await descriptorSeen;
    assert.equal(descriptor.capability, 'write');
    assert.equal(descriptor.risk.level, 'medium');
    assert.match(descriptor.diff ?? '', /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(descriptor), /super-secret/);
    assert.equal(await readFile(join(fx.project, 'src', 'message.txt'), 'utf8'), 'before\n');

    releaseApproval('allow_once');
    const result = await pending;
    assert.ok(result.checkpointId);
    assert.match(result.diff ?? '', /^--- a\/src\/message\.txt/m);
    assert.equal(
      await readFile(join(fx.project, 'src', 'message.txt'), 'utf8'),
      'TOKEN=super-secret\nafter\n',
    );
    assert.doesNotMatch(JSON.stringify(tools.auditRecords()), /super-secret/);
    assert.deepEqual(
      tools.auditRecords().map((record) => record.action),
      ['requested', 'approval_required', 'approval_decided', 'succeeded'],
    );
  } finally {
    await fx.cleanup();
  }
});

test('ask mode can suspend with an explicit ApprovalRequired descriptor', async () => {
  const fx = await fixture('ask');
  try {
    await assert.rejects(
      () => fx.tools.execute('write_file', { path: 'src/message.txt', content: 'after\n' }),
      (error: unknown) => {
        assert.ok(error instanceof ApprovalRequired);
        assert.equal(error.descriptor.tool, 'write_file');
        assert.ok(error.descriptor.id);
        assert.match(error.descriptor.diff ?? '', /^--- /);
        return true;
      },
    );
    assert.equal(await readFile(join(fx.project, 'src', 'message.txt'), 'utf8'), 'before\n');
  } finally {
    await fx.cleanup();
  }
});

test('an AbortSignal cancels a pending approval without writing', async () => {
  const fx = await fixture('ask');
  let approvalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    approvalStarted = resolve;
  });
  const tools = createCoreToolRegistration({
    workspace: fx.workspace,
    policy: 'ask',
    approval: async () => {
      approvalStarted();
      return new Promise<ApprovalDecision>(() => undefined);
    },
  });
  const controller = new AbortController();
  try {
    const pending = tools.execute(
      'write_file',
      { path: 'src/message.txt', content: 'cancelled\n' },
      { signal: controller.signal },
    );
    await started;
    controller.abort(new Error('cancelled by test'));
    await assert.rejects(() => pending, /cancelled by test/);
    assert.equal(await readFile(join(fx.project, 'src', 'message.txt'), 'utf8'), 'before\n');
  } finally {
    await fx.cleanup();
  }
});

test('allow_session is scoped to the exact high-risk command signature', async () => {
  const fx = await fixture('allow');
  let approvals = 0;
  const tools = createCoreToolRegistration({
    workspace: fx.workspace,
    policy: 'allow',
    approval: async () => {
      approvals += 1;
      return 'allow_session';
    },
  });
  try {
    await tools.execute('run_command', { command: 'printf safe' });
    await tools.execute('run_command', { command: 'printf safe' });
    assert.equal(approvals, 1);

    await tools.execute('run_command', { command: 'printf different' });
    assert.equal(approvals, 2);
  } finally {
    await fx.cleanup();
  }
});

test('write returns a checkpoint and undo restores the exact previous file', async () => {
  const fx = await fixture();
  try {
    const written = await fx.tools.execute('write_file', {
      path: 'src/message.txt',
      content: 'after\n',
    });
    assert.ok(written.checkpointId);
    assert.match(written.diff ?? '', /-before\n\+after/);

    const undone = await fx.tools.undo(written.checkpointId!);
    assert.match(undone.diff ?? '', /-after\n\+before/);
    assert.equal(await readFile(join(fx.project, 'src', 'message.txt'), 'utf8'), 'before\n');
    await assert.rejects(() => fx.tools.undo(written.checkpointId!), /unknown or expired checkpoint/);
  } finally {
    await fx.cleanup();
  }
});

test('undo refuses to clobber a file changed after its checkpoint', async () => {
  const fx = await fixture();
  try {
    const written = await fx.tools.execute('write_file', {
      path: 'src/message.txt',
      content: 'after\n',
    });
    await writeFile(join(fx.project, 'src', 'message.txt'), 'newer work\n');
    await assert.rejects(() => fx.tools.undo(written.checkpointId!), /refusing to overwrite newer work/);
    assert.equal(await readFile(join(fx.project, 'src', 'message.txt'), 'utf8'), 'newer work\n');
  } finally {
    await fx.cleanup();
  }
});

test('undo removes a newly-created file', async () => {
  const fx = await fixture();
  try {
    const written = await fx.tools.execute('write_file', { path: 'src/new.txt', content: 'new\n' });
    await fx.tools.undo(written.checkpointId!);
    await assert.rejects(() => readFile(join(fx.project, 'src', 'new.txt')),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
  } finally {
    await fx.cleanup();
  }
});

test('serialized checkpoints survive a task registration restart', async () => {
  const fx = await fixture();
  try {
    const written = await fx.tools.execute('write_file', {
      path: 'src/message.txt',
      content: 'after restart\n',
    });
    const checkpoints = fx.tools.exportCheckpoints();
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]?.path, 'src/message.txt');
    const tampered = structuredClone(checkpoints);
    tampered[0]!.path = '../outside/secret.txt';
    assert.throws(
      () => createCoreToolRegistration({
        workspace: fx.workspace,
        policy: 'allow',
        checkpoints: tampered,
      }),
      /invalid workspace-relative path/,
    );

    const resumed = createCoreToolRegistration({
      workspace: fx.workspace,
      policy: 'allow',
      checkpoints,
    });
    await resumed.undo(written.checkpointId!);
    assert.equal(await readFile(join(fx.project, 'src', 'message.txt'), 'utf8'), 'before\n');
    assert.deepEqual(resumed.exportCheckpoints(), []);
  } finally {
    await fx.cleanup();
  }
});

test('filesystem tools reject traversal, absolute outside paths, and escaping symlinks', async () => {
  const fx = await fixture();
  try {
    await symlink(join(fx.outside, 'secret.txt'), join(fx.project, 'outside-link'));
    await assert.rejects(
      () => fx.tools.execute('read_file', { path: '../outside/secret.txt' }),
      WorkspaceError,
    );
    await assert.rejects(
      () => fx.tools.execute('write_file', { path: join(fx.outside, 'new.txt'), content: 'bad' }),
      WorkspaceError,
    );
    await assert.rejects(
      () => fx.tools.execute('read_file', { path: 'outside-link' }),
      WorkspaceError,
    );
  } finally {
    await fx.cleanup();
  }
});

test('command runner is shell-free, confined, redacted, and destructive-git-proof', async () => {
  const fx = await fixture();
  try {
    await symlink(join(fx.outside, 'secret.txt'), join(fx.project, 'outside-link'));
    await assert.rejects(
      () => fx.tools.execute('run_command', { command: 'printf safe | cat' }),
      /pipes and redirects/,
    );
    await assert.rejects(
      () => fx.tools.execute('run_command', { command: 'cat ../outside/secret.txt' }),
      WorkspaceError,
    );
    await assert.rejects(
      () => fx.tools.execute('run_command', { command: 'cat outside-link' }),
      WorkspaceError,
    );
    await assert.rejects(
      () => fx.tools.execute('run_command', { command: 'git reset --hard' }),
      /direct git commands are disabled/,
    );

    const approved = createCoreToolRegistration({
      workspace: fx.workspace,
      policy: 'allow',
      approval: async () => 'allow_once',
    });
    const output = await approved.execute('run_command', { command: "printf 'TOKEN=command-secret'" });
    assert.doesNotMatch(output.content, /command-secret/);
    assert.match(output.content, /\[REDACTED\]/);
  } finally {
    await fx.cleanup();
  }
});

test('command sequences approve and run each step with shell gates', async () => {
  const fx = await fixture();
  try {
    let approvals = 0;
    const tools = createCoreToolRegistration({
      workspace: fx.workspace,
      policy: 'allow',
      approval: async () => {
        approvals += 1;
        return 'allow_once';
      },
    });

    const both = await tools.execute('run_command', { command: 'printf one && printf two' });
    assert.equal(approvals, 2);
    const bothSteps = JSON.parse(both.content) as {
      steps: Array<{ command: string; status: string; output: { stdout: string } }>;
    };
    assert.deepEqual(bothSteps.steps.map((step) => step.status), ['ok', 'ok']);
    assert.match(bothSteps.steps[0]!.output.stdout, /one/);
    assert.match(bothSteps.steps[1]!.output.stdout, /two/);

    // `&&` stops after a failure…
    approvals = 0;
    const stopped = await tools.execute('run_command', { command: 'ls no-such-dir-xyz && printf never' });
    assert.equal(approvals, 1);
    const stoppedSteps = JSON.parse(stopped.content) as { steps: Array<{ status: string }> };
    assert.deepEqual(stoppedSteps.steps.map((step) => step.status), ['failed', 'skipped']);

    // …while `;` continues and `||` recovers.
    approvals = 0;
    const recovered = await tools.execute('run_command', { command: 'ls no-such-dir-xyz ; printf after || printf fallback' });
    assert.equal(approvals, 2);
    const recoveredSteps = JSON.parse(recovered.content) as {
      steps: Array<{ status: string; output: { stdout: string } | null }>;
    };
    assert.deepEqual(recoveredSteps.steps.map((step) => step.status), ['failed', 'ok', 'skipped']);
    assert.match(recoveredSteps.steps[1]!.output!.stdout, /after/);

    // `cd` moves later steps but cannot escape the workspace.
    approvals = 0;
    const moved = await tools.execute('run_command', { command: 'cd src && pwd' });
    assert.equal(approvals, 1);
    const movedSteps = JSON.parse(moved.content) as {
      steps: Array<{ status: string; output: { stdout?: string } | null }>;
    };
    assert.deepEqual(movedSteps.steps.map((step) => step.status), ['ok', 'ok']);
    assert.match(movedSteps.steps[1]!.output!.stdout!, /src/);
    await assert.rejects(
      () => tools.execute('run_command', { command: 'cd .. && pwd' }),
      WorkspaceError,
    );

    // A dangerous step is still confined even mid-sequence.
    await assert.rejects(
      () => tools.execute('run_command', { command: 'printf safe; cat /etc/passwd' }),
      WorkspaceError,
    );
  } finally {
    await fx.cleanup();
  }
});

test('denying one sequence step aborts the whole sequence', async () => {
  const fx = await fixture();
  try {
    let calls = 0;
    const tools = createCoreToolRegistration({
      workspace: fx.workspace,
      policy: 'allow',
      approval: async () => {
        calls += 1;
        return calls === 1 ? 'allow_once' : 'deny';
      },
    });
    await assert.rejects(
      () => tools.execute('run_command', { command: 'printf one && printf two' }),
      ToolDenied,
    );
    assert.equal(calls, 2);
  } finally {
    await fx.cleanup();
  }
});

test('read output and audit records redact secrets', async () => {
  const fx = await fixture();
  try {
    await writeFile(
      join(fx.project, 'src', 'credentials.txt'),
      'api_key: sk-abcdefghijklmnopqrst\nAuthorization: Bearer abcdefghijklmnop\n',
    );
    const result = await fx.tools.execute('read_file', { path: 'src/credentials.txt' });
    assert.doesNotMatch(result.content, /abcdefghijklmnopqrst|abcdefghijklmnop/);
    assert.match(result.content, /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(fx.tools.auditRecords()), /abcdefghijklmnopqrst|abcdefghijklmnop/);
  } finally {
    await fx.cleanup();
  }
});

test('enforces file, output, and command time limits', async () => {
  const fx = await fixture();
  const approved = createCoreToolRegistration({
    workspace: fx.workspace,
    policy: 'allow',
    approval: async () => 'allow_once',
  });
  try {
    const large = 'x'.repeat(150_000);
    await writeFile(join(fx.project, 'src', 'large.txt'), large);

    const read = await fx.tools.execute('read_file', { path: 'src/large.txt' });
    assert.equal(read.truncated, true);
    assert.ok(Buffer.byteLength(read.content, 'utf8') <= 100_000);

    const command = await approved.execute('run_command', { command: 'cat src/large.txt' });
    assert.equal(command.truncated, true);
    assert.ok(Buffer.byteLength(command.content, 'utf8') <= 100_000);

    const timeoutStartedAt = Date.now();
    const timedOut = await approved.execute('run_command', { command: 'sleep 1', timeout_ms: 10 });
    const timeoutElapsedMs = Date.now() - timeoutStartedAt;
    assert.ok(timeoutElapsedMs < 2_000, `timed-out command settled after ${timeoutElapsedMs}ms`);
    assert.ok(
      timedOut.data
      && typeof timedOut.data === 'object'
      && 'timedOut' in timedOut.data
      && timedOut.data.timedOut === true,
    );
    assert.ok(
      timedOut.data
      && typeof timedOut.data === 'object'
      && 'exitCode' in timedOut.data
      && timedOut.data.exitCode === null,
    );

    const oversizedStartedAt = Date.now();
    await assert.rejects(
      () => fx.tools.execute('write_file', { path: 'too-large.txt', content: 'x'.repeat(1_000_001) }),
      /write limit/,
    );
    const oversizedElapsedMs = Date.now() - oversizedStartedAt;
    assert.ok(oversizedElapsedMs < 2_000, `oversized write rejected after ${oversizedElapsedMs}ms`);
  } finally {
    await fx.cleanup();
  }
});

test('allow mode still requires explicit approval for commands and commits', async () => {
  const fx = await fixture('allow');
  try {
    await assert.rejects(
      () => fx.tools.execute('run_command', { command: 'printf safe' }),
      (error: unknown) => {
        assert.ok(error instanceof ApprovalRequired);
        assert.equal(error.descriptor.tool, 'run_command');
        assert.equal(error.descriptor.risk.level, 'high');
        return true;
      },
    );

    await initializeGit(fx.project);
    await writeFile(join(fx.project, 'src', 'message.txt'), 'staged\n');
    await runGitFixture(fx.project, ['add', 'src/message.txt']);
    await assert.rejects(
      () => fx.tools.execute('git_commit', { message: 'Must approve' }),
      (error: unknown) => {
        assert.ok(error instanceof ApprovalRequired);
        assert.equal(error.descriptor.tool, 'git_commit');
        assert.equal(error.descriptor.risk.level, 'high');
        return true;
      },
    );
    const subject = await runGitFixture(fx.project, ['log', '-1', '--pretty=%s']);
    assert.equal(subject.trim(), 'Initial');
  } finally {
    await fx.cleanup();
  }
});

test('commit session approval is bound to the reviewed staged diff', async () => {
  const fx = await fixture('allow');
  let approvals = 0;
  const tools = createCoreToolRegistration({
    workspace: fx.workspace,
    policy: 'allow',
    approval: async () => {
      approvals += 1;
      return 'allow_session';
    },
  });
  try {
    await initializeGit(fx.project);
    await writeFile(join(fx.project, 'src', 'message.txt'), 'first staged change\n');
    await runGitFixture(fx.project, ['add', 'src/message.txt']);
    await tools.execute('git_commit', { message: 'Repeatable message' });
    assert.equal(approvals, 1);

    await writeFile(join(fx.project, 'src', 'message.txt'), 'different staged change\n');
    await runGitFixture(fx.project, ['add', 'src/message.txt']);
    await tools.execute('git_commit', { message: 'Repeatable message' });
    assert.equal(approvals, 2);
  } finally {
    await fx.cleanup();
  }
});

test('guarded git tools inspect and commit staged changes without exposing destructive git', async () => {
  const fx = await fixture();
  try {
    await initializeGit(fx.project);
    await writeFile(join(fx.project, 'src', 'message.txt'), 'changed\n');

    const status = await fx.tools.execute('git_status', {});
    assert.match(status.content, /src\/message\.txt/);
    const diff = await fx.tools.execute('git_diff', { path: 'src/message.txt' });
    assert.match(diff.content, /-before\n\+changed/);

    await runGitFixture(fx.project, ['add', 'src/message.txt']);
    const approved = createCoreToolRegistration({
      workspace: fx.workspace,
      policy: 'allow',
      approval: async () => 'allow_once',
    });
    const committed = await approved.execute('git_commit', { message: 'Update message' });
    assert.match(committed.content, /Update message/);
    const subject = await runGitFixture(fx.project, ['log', '-1', '--pretty=%s']);
    assert.equal(subject.trim(), 'Update message');
  } finally {
    await fx.cleanup();
  }
});

test('git tools reject a workspace nested under a larger repository', async () => {
  const fx = await fixture();
  try {
    await initializeGit(fx.project);
    const nestedWorkspace = new Workspace();
    await nestedWorkspace.select(join(fx.project, 'src'));
    const tools = createCoreToolRegistration({ workspace: nestedWorkspace, policy: 'allow' });
    await assert.rejects(() => tools.execute('git_status', {}), WorkspaceError);
  } finally {
    await fx.cleanup();
  }
});

test('ask-mode git inspection has an explicit approval descriptor', async () => {
  const fx = await fixture();
  const approvals: ApprovalDescriptor[] = [];
  try {
    await initializeGit(fx.project);
    const tools = createCoreToolRegistration({
      workspace: fx.workspace,
      policy: 'ask',
      approval: async (descriptor) => {
        approvals.push(descriptor);
        return 'allow_once';
      },
    });
    await tools.execute('git_status', {});
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.capability, 'git');
  } finally {
    await fx.cleanup();
  }
});
