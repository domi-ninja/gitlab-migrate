#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HELPER_SCRIPT = path.join(__dirname, 'github-banner-sync.cjs');
const HOOK_MARKER = '# _gitlab-managed-post-push';
const DEFAULT_GITLAB_HOST = 'gitlab.com';
const DEFAULT_VISIBILITY = 'private';

function parseArgs(argv) {
  const noArgs = argv.length === 0;
  const args = {
    root: ROOT,
    namespace: process.env.GITLAB_NAMESPACE || '',
    hostname: process.env.GITLAB_HOST || DEFAULT_GITLAB_HOST,
    githubOwner: process.env.GITHUB_OWNER || '',
    dryRun: false,
    include: [],
    skipHooks: false,
    diagnosticsFile: path.join(__dirname, 'last-run.json'),
    cloneMissing: noArgs,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--root') {
      args.root = path.resolve(argv[i + 1] || args.root);
      i += 1;
    } else if (value === '--namespace') {
      args.namespace = argv[i + 1] || '';
      i += 1;
    } else if (value === '--hostname') {
      args.hostname = argv[i + 1] || DEFAULT_GITLAB_HOST;
      i += 1;
    } else if (value === '--github-owner') {
      args.githubOwner = argv[i + 1] || '';
      i += 1;
    } else if (value === '--include') {
      args.include = (argv[i + 1] || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    } else if (value === '--clone-missing') {
      args.cloneMissing = true;
    } else if (value === '--no-clone-missing') {
      args.cloneMissing = false;
    } else if (value === '--dry-run') {
      args.dryRun = true;
    } else if (value === '--skip-hooks') {
      args.skipHooks = true;
    } else if (value === '--diagnostics-file') {
      args.diagnosticsFile = path.resolve(argv[i + 1] || args.diagnosticsFile);
      i += 1;
    }
  }

  return args;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    env: options.env || process.env,
  });

  if (result.status !== 0) {
    const error = new Error(
      `${command} ${commandArgs.join(' ')} failed: ${
        (result.stderr || result.stdout || '').trim() || `exit ${result.status}`
      }`,
    );
    error.result = result;
    throw error;
  }

  return (result.stdout || '').trim();
}

function runQuiet(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    env: options.env || process.env,
  });
}

function runJson(command, commandArgs, options = {}) {
  return JSON.parse(run(command, commandArgs, options));
}

function ensureCommandAvailable(command) {
  const result = runQuiet('which', [command]);
  if (result.status !== 0) {
    throw new Error(`required command not found: ${command}`);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isGitHubUrl(remoteUrl) {
  return /github\.com[:/]/i.test(remoteUrl);
}

function isGitLabUrl(remoteUrl, hostname = DEFAULT_GITLAB_HOST) {
  const escapedHost = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escapedHost}[:/]`, 'i').test(remoteUrl);
}

function parseRemoteSlug(remoteUrl) {
  const sshMatch = remoteUrl.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1].replace(/\.git$/, '');
  }

  const httpsMatch = remoteUrl.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return httpsMatch[1].replace(/\.git$/, '');
  }

  return '';
}

function extractNamespace(remoteUrl) {
  const slug = parseRemoteSlug(remoteUrl);
  if (!slug || !slug.includes('/')) {
    return '';
  }

  const parts = slug.split('/');
  parts.pop();
  return parts.join('/');
}

function extractProjectName(remoteUrl) {
  const slug = parseRemoteSlug(remoteUrl);
  if (!slug) {
    return '';
  }

  const parts = slug.split('/');
  return parts[parts.length - 1] || '';
}

function visibilityToGlabFlag(visibility) {
  if (visibility === 'public') {
    return '--public';
  }

  if (visibility === 'internal') {
    return '--internal';
  }

  return '--private';
}

function listRepos(root, include) {
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '.git' && entry.name !== '.vscode')
    .filter((entry) => fs.existsSync(path.join(root, entry.name, '.git')));

  const repoNames = include.length
    ? entries.map((entry) => entry.name).filter((name) => include.includes(name))
    : entries.map((entry) => entry.name);

  return repoNames
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      path: path.join(root, name),
    }));
}

function inferNamespace(args, repos) {
  if (args.namespace) {
    return args.namespace;
  }

  const namespaces = new Set();
  for (const repo of repos) {
    const remotes = runQuiet('git', ['-C', repo.path, 'remote']).stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const remote of remotes) {
      const url = runQuiet('git', ['-C', repo.path, 'remote', 'get-url', remote]).stdout.trim();
      if (url && isGitLabUrl(url, args.hostname)) {
        const namespace = extractNamespace(url);
        if (namespace) {
          namespaces.add(namespace);
        }
      }
    }
  }

  if (namespaces.size === 1) {
    return [...namespaces][0];
  }

  return '';
}

function hasGlabApiAuth(hostname) {
  const result = runQuiet('glab', ['api', 'user', '--hostname', hostname]);
  return result.status === 0;
}

function getGitHubOwner(args) {
  if (args.githubOwner) {
    return args.githubOwner;
  }

  const user = runJson('gh', ['api', 'user']);
  return user.login;
}

function listGitHubRepos(owner) {
  return runJson('gh', [
    'repo',
    'list',
    owner,
    '--limit',
    '1000',
    '--json',
    'name,visibility,isPrivate,isArchived,isFork,sshUrl,url,owner',
  ]);
}

function getExistingGitHubRepoNames(root) {
  const names = new Set();
  const repos = listRepos(root, []);

  for (const repo of repos) {
    names.add(repo.name);
    const remotes = runQuiet('git', ['-C', repo.path, 'remote']).stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const remote of remotes) {
      const url = runQuiet('git', ['-C', repo.path, 'remote', 'get-url', remote]).stdout.trim();
      if (isGitHubUrl(url)) {
        const projectName = extractProjectName(url);
        if (projectName) {
          names.add(projectName);
        }
      }
    }
  }

  return names;
}

function cloneMissingGithubRepos(args, diagnostics) {
  const owner = getGitHubOwner(args);
  const existingNames = getExistingGitHubRepoNames(args.root);
  const githubRepos = listGitHubRepos(owner);
  const results = [];

  for (const repo of githubRepos) {
    const targetPath = path.join(args.root, repo.name);
    const represented = existingNames.has(repo.name);

    if (repo.isFork) {
      results.push({
        name: repo.name,
        status: 'skipped',
        reason: 'forked GitHub repo',
      });
      continue;
    }

    if (represented) {
      results.push({
        name: repo.name,
        status: 'skipped',
        reason: 'already represented locally',
      });
      continue;
    }

    if (fs.existsSync(targetPath)) {
      results.push({
        name: repo.name,
        status: 'skipped',
        reason: `target path already exists (${targetPath})`,
      });
      continue;
    }

    if (args.dryRun) {
      console.log(`[dry-run] gh repo clone ${shellQuote(`${owner}/${repo.name}`)} ${shellQuote(targetPath)}`);
      results.push({
        name: repo.name,
        status: 'dry-run',
        reason: `would clone ${owner}/${repo.name}`,
      });
      continue;
    }

    try {
      run('gh', ['repo', 'clone', `${owner}/${repo.name}`, targetPath], { cwd: args.root });
      results.push({
        name: repo.name,
        status: 'ok',
        reason: '',
      });
      existingNames.add(repo.name);
    } catch (error) {
      results.push({
        name: repo.name,
        status: 'blocked',
        reason: error.message,
      });
    }
  }

  diagnostics.clonePhase = {
    enabled: true,
    owner,
    results,
  };
}

function getRepoState(repo, namespace, hostname) {
  const branch = runQuiet('git', ['-C', repo.path, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const worktreeStatus = runQuiet('git', ['-C', repo.path, 'status', '--porcelain']).stdout.trim();
  const remotes = runQuiet('git', ['-C', repo.path, 'remote']).stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const remoteUrls = {};
  for (const remote of remotes) {
    remoteUrls[remote] = runQuiet('git', ['-C', repo.path, 'remote', 'get-url', remote]).stdout.trim();
  }

  const originUrl = remoteUrls.origin || '';
  const githubUrl = remoteUrls.github || '';
  const hasGitHubRemote = Boolean(githubUrl);
  const originWillBeRenamed = isGitHubUrl(originUrl) && !hasGitHubRemote;
  const effectiveOriginUrl = originWillBeRenamed ? '' : originUrl;
  const simulatedGitHubUrl = hasGitHubRemote ? githubUrl : originWillBeRenamed ? originUrl : '';
  const simulatedOriginIsGitLab = isGitLabUrl(effectiveOriginUrl, hostname);

  const blockers = [];
  const warnings = [];
  const actions = [];

  let metadata = null;
  let metadataWarning = '';
  if (simulatedGitHubUrl) {
    const githubSlug = parseRemoteSlug(simulatedGitHubUrl);
    try {
      metadata = runJson('gh', [
        'repo',
        'view',
        githubSlug,
        '--json',
        'name,description,visibility,isPrivate,isFork,url',
      ]);
    } catch (error) {
      metadataWarning = error.message;
      warnings.push('GitHub metadata lookup failed; using remote slug/local name fallback');
    }
  }

  const projectName = metadata?.name || extractProjectName(simulatedGitHubUrl) || repo.name;
  const description = metadata?.description || '';
  const visibility = metadata?.visibility || DEFAULT_VISIBILITY;
  const targetNamespace = namespace;
  const gitlabSshUrl = targetNamespace
    ? `git@${hostname}:${targetNamespace}/${projectName}.git`
    : '';

  if (!branch || branch === 'HEAD') {
    blockers.push('detached HEAD');
  }

  if (worktreeStatus) {
    warnings.push('dirty working tree');
  }

  if (metadata?.isFork) {
    blockers.push('forked GitHub repo');
  }

  if (effectiveOriginUrl && !isGitHubUrl(effectiveOriginUrl) && !isGitLabUrl(effectiveOriginUrl, hostname)) {
    blockers.push(`origin is neither GitHub nor GitLab (${effectiveOriginUrl})`);
  }

  if (originWillBeRenamed) {
    actions.push(`rename origin -> github (${originUrl})`);
  }

  if (!simulatedOriginIsGitLab) {
    if (!targetNamespace) {
      blockers.push('unable to infer GitLab namespace; pass --namespace or set GITLAB_NAMESPACE');
    } else {
      actions.push(`ensure GitLab project ${targetNamespace}/${projectName}`);
      actions.push(`set origin -> ${gitlabSshUrl}`);
    }
  }

  actions.push(`push branch ${branch} to origin`);
  actions.push('install post-push hook');

  return {
    ...repo,
    branch,
    remotes,
    remoteUrls,
    originUrl,
    effectiveOriginUrl,
    originWillBeRenamed,
    githubUrl: simulatedGitHubUrl,
    metadata,
    metadataWarning,
    projectName,
    description,
    visibility,
    namespace: targetNamespace,
    gitlabSshUrl,
    originIsGitLab: simulatedOriginIsGitLab,
    blockers,
    warnings,
    actions,
    worktreeStatus,
  };
}

function gitlabProjectExists(hostname, namespace, projectName) {
  const encoded = encodeURIComponent(`${namespace}/${projectName}`);
  const result = runQuiet('glab', ['api', `projects/${encoded}`, '--hostname', hostname]);
  if (result.status === 0) {
    return true;
  }

  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (/404/.test(output)) {
    return false;
  }

  throw new Error(output.trim() || `glab api projects/${encoded} failed`);
}

function ensureGitLabProject(state, args) {
  if (state.originIsGitLab) {
    return;
  }

  const exists = gitlabProjectExists(args.hostname, state.namespace, state.projectName);
  if (exists) {
    if (!state.effectiveOriginUrl) {
      if (args.dryRun) {
        console.log(`[dry-run] git -C "${state.path}" remote add origin "${state.gitlabSshUrl}"`);
      } else {
        run('git', ['-C', state.path, 'remote', 'add', 'origin', state.gitlabSshUrl]);
      }
    }
    return;
  }

  const commandArgs = [
    'repo',
    'create',
    `${state.namespace}/${state.projectName}`,
    visibilityToGlabFlag(state.visibility),
    '--hostname',
    args.hostname,
    '--remoteName',
    'origin',
  ];

  if (state.description) {
    commandArgs.push('--description', state.description);
  }

  if (args.dryRun) {
    console.log(`[dry-run] glab ${commandArgs.map(shellQuote).join(' ')} (cwd=${state.path})`);
    return;
  }

  run('glab', commandArgs, { cwd: state.path });
}

function pushBranch(state, args) {
  const commandArgs = ['-C', state.path, 'push', '-u', 'origin', state.branch];
  if (args.dryRun) {
    console.log(`[dry-run] git ${commandArgs.map(shellQuote).join(' ')}`);
    return;
  }

  run('git', commandArgs);
}

function installSyncHook(state, args) {
  const hooksDir = run('git', ['-C', state.path, 'rev-parse', '--git-path', 'hooks']);
  const hookName = 'pre-push';
  const hookPath = path.join(hooksDir, hookName);
  const backupPath = path.join(hooksDir, `${hookName}.pre-gitlab-migrate`);
  const legacyPostPushPath = path.join(hooksDir, 'post-push');

  const hookBody = `#!/bin/sh
${HOOK_MARKER}
backup_hook="$(dirname "$0")/${hookName}.pre-gitlab-migrate"
if [ -x "$backup_hook" ]; then
  "$backup_hook" "$@" || true
fi
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  exit 0
fi
${shellQuote(process.execPath)} ${shellQuote(HELPER_SCRIPT)} --repo "$repo_root" --remote "$1" --url "$2"
`;

  if (args.dryRun) {
    console.log(`[dry-run] install pre-push hook in ${state.name}`);
    return;
  }

  fs.mkdirSync(hooksDir, { recursive: true });
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (!existing.includes(HOOK_MARKER)) {
      if (!fs.existsSync(backupPath)) {
        fs.renameSync(hookPath, backupPath);
      } else {
        fs.writeFileSync(`${backupPath}.${Date.now()}`, existing, 'utf8');
      }
    }
  }

  fs.writeFileSync(hookPath, hookBody, 'utf8');
  fs.chmodSync(hookPath, 0o755);

  if (fs.existsSync(legacyPostPushPath)) {
    const legacy = fs.readFileSync(legacyPostPushPath, 'utf8');
    if (legacy.includes(HOOK_MARKER)) {
      fs.rmSync(legacyPostPushPath, { force: true });
    }
  }
}

function syncGithubBannerImmediately(state, args) {
  if (!state.githubUrl || !isGitLabUrl(state.gitlabSshUrl, args.hostname)) {
    return;
  }

  const localSha = runQuiet('git', ['-C', state.path, 'rev-parse', 'HEAD']).stdout.trim();
  if (!localSha) {
    throw new Error(`unable to resolve HEAD for immediate banner sync in ${state.name}`);
  }

  const stdin = `${localSha} refs/heads/${state.branch} 0000000000000000000000000000000000000000 refs/heads/${state.branch}\n`;
  const commandArgs = [
    HELPER_SCRIPT,
    '--repo',
    state.path,
    '--remote',
    'origin',
    '--url',
    state.gitlabSshUrl,
  ];

  if (args.dryRun) {
    commandArgs.push('--dry-run');
  }

  const output = run(process.execPath, commandArgs, {
    cwd: state.path,
    input: stdin,
  });
  if (output) {
    console.log(output);
  }
}

function executeRepo(state, args, glabAuthReady) {
  if (state.blockers.length > 0) {
    return { status: 'blocked', reason: state.blockers.join('; ') };
  }

  if (!state.originIsGitLab && !glabAuthReady) {
    return { status: 'blocked', reason: `glab API auth missing for ${args.hostname}` };
  }

  try {
    if (isGitHubUrl(state.originUrl) && !state.remoteUrls.github) {
      if (args.dryRun) {
        console.log(`[dry-run] git -C "${state.path}" remote rename origin github`);
      } else {
        run('git', ['-C', state.path, 'remote', 'rename', 'origin', 'github']);
      }
    }

    ensureGitLabProject(state, args);
    pushBranch(state, args);
    if (!args.skipHooks) {
      installSyncHook(state, args);
    }
    syncGithubBannerImmediately(state, args);
    return { status: args.dryRun ? 'dry-run' : 'ok' };
  } catch (error) {
    return { status: 'blocked', reason: error.message };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureCommandAvailable('git');
  ensureCommandAvailable('gh');
  ensureCommandAvailable('glab');

  if (!hasGlabApiAuth(args.hostname)) {
    throw new Error(
      `glab is installed but not authenticated for ${args.hostname}; run 'glab auth login' first`,
    );
  }

  const diagnostics = {
    root: args.root,
    hostname: args.hostname,
    dryRun: args.dryRun,
    cloneMissing: args.cloneMissing,
    generatedAt: new Date().toISOString(),
    repos: [],
  };

  if (args.cloneMissing) {
    cloneMissingGithubRepos(args, diagnostics);
  } else {
    diagnostics.clonePhase = {
      enabled: false,
      owner: '',
      results: [],
    };
  }

  const repos = listRepos(args.root, args.include);
  const namespace = inferNamespace(args, repos);
  const glabAuthReady = true;
  diagnostics.namespace = namespace;
  diagnostics.glabAuthReady = glabAuthReady;

  console.log(`Root: ${args.root}`);
  console.log(`GitLab host: ${args.hostname}`);
  console.log(`GitHub clone phase: ${args.cloneMissing ? 'enabled' : 'disabled'}`);
  if (diagnostics.clonePhase.owner) {
    console.log(`GitHub owner: ${diagnostics.clonePhase.owner}`);
  }
  console.log(`GitLab namespace: ${namespace || '(not inferred)'}`);
  console.log(`glab API auth: ${glabAuthReady ? 'ready' : 'missing'}`);
  console.log(`Mode: ${args.dryRun ? 'dry-run' : 'live'}`);
  console.log('');

  const summary = {
    ok: [],
    dryRun: [],
    blocked: [],
  };

  for (const repo of repos) {
    let state;
    try {
      state = getRepoState(repo, namespace, args.hostname);
    } catch (error) {
      diagnostics.repos.push({
        name: repo.name,
        path: repo.path,
        status: 'blocked',
        blockers: [`state collection failed: ${error.message}`],
      });
      summary.blocked.push(`${repo.name}: state collection failed: ${error.message}`);
      console.log(`== ${repo.name} ==`);
      console.log(`  ! blocked: state collection failed: ${error.message}`);
      console.log('');
      continue;
    }
    console.log(`== ${repo.name} ==`);
    console.log(`branch: ${state.branch || '(unknown)'}`);
    console.log(`origin: ${state.originUrl || '(none)'}`);
    console.log(`github: ${state.githubUrl || '(none)'}`);
    console.log(`planned GitLab: ${state.gitlabSshUrl || '(unknown)'}`);
    for (const warning of state.warnings) {
      console.log(`  ! warning: ${warning}`);
    }
    for (const action of state.actions) {
      console.log(`  - ${action}`);
    }
    if (state.blockers.length > 0) {
      for (const blocker of state.blockers) {
        console.log(`  ! blocker: ${blocker}`);
      }
    }

    const result = executeRepo(state, args, glabAuthReady);
    diagnostics.repos.push({
      name: state.name,
      path: state.path,
      branch: state.branch,
      origin: state.originUrl,
      github: state.githubUrl,
      plannedGitLab: state.gitlabSshUrl,
      actions: state.actions,
      warnings: state.warnings,
      blockers: state.blockers,
      worktreeStatus: state.worktreeStatus,
      status: result.status,
      result: result.reason || '',
    });
    if (result.status === 'ok') {
      summary.ok.push(repo.name);
    } else if (result.status === 'dry-run') {
      summary.dryRun.push(repo.name);
    } else {
      summary.blocked.push(`${repo.name}: ${result.reason}`);
      console.log(`  ! blocked: ${result.reason}`);
    }
    console.log('');
  }

  diagnostics.summary = {
    clonedOk: diagnostics.clonePhase.results.filter((item) => item.status === 'ok').length,
    clonedDryRun: diagnostics.clonePhase.results.filter((item) => item.status === 'dry-run').length,
    clonedSkipped: diagnostics.clonePhase.results.filter((item) => item.status === 'skipped').length,
    clonedBlocked: diagnostics.clonePhase.results.filter((item) => item.status === 'blocked').length,
    ok: summary.ok.length,
    dryRun: summary.dryRun.length,
    blocked: summary.blocked.length,
    blockedRepos: summary.blocked,
  };
  fs.writeFileSync(args.diagnosticsFile, JSON.stringify(diagnostics, null, 2), 'utf8');

  console.log('Summary');
  if (args.cloneMissing) {
    console.log(
      `  clone phase: ok=${diagnostics.summary.clonedOk} dry-run=${diagnostics.summary.clonedDryRun} skipped=${diagnostics.summary.clonedSkipped} blocked=${diagnostics.summary.clonedBlocked}`,
    );
  }
  console.log(`  ok: ${summary.ok.length}`);
  console.log(`  dry-run: ${summary.dryRun.length}`);
  console.log(`  blocked: ${summary.blocked.length}`);
  console.log(`  diagnostics: ${args.diagnosticsFile}`);
  if (summary.blocked.length > 0) {
    console.log('Blocked repos:');
    for (const item of summary.blocked) {
      console.log(`  - ${item}`);
    }
  }
}

main();
