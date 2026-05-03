#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RECURSION_GUARD = 'GITLAB_GITHUB_BANNER_SYNC_ACTIVE';
const BANNER_MARKER = '<!-- moved-to-gitlab -->';
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_REASON =
  'We moved off GitHub because it became unreliable after the Microsoft acquisition.';

function parseArgs(argv) {
  const args = {
    repo: '',
    remote: '',
    url: '',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--repo') {
      args.repo = argv[i + 1] || '';
      i += 1;
    } else if (value === '--remote') {
      args.remote = argv[i + 1] || '';
      i += 1;
    } else if (value === '--url') {
      args.url = argv[i + 1] || '';
      i += 1;
    } else if (value === '--dry-run') {
      args.dryRun = true;
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
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    env: options.env || process.env,
  });

  return result;
}

function isAllZeroSha(sha) {
  return /^0+$/.test(sha);
}

function parseRefLines(stdin) {
  return stdin
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length !== 4) {
        return null;
      }

      const [localSha, localRef, remoteSha, remoteRef] = parts;
      return { localSha, localRef, remoteSha, remoteRef };
    })
    .filter(Boolean);
}

function parseSshOrHttpsRemote(remoteUrl) {
  const sshMatch = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      host: sshMatch[1],
      path: sshMatch[2].replace(/\.git$/, ''),
    };
  }

  const httpsMatch = remoteUrl.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return {
      host: httpsMatch[1],
      path: httpsMatch[2].replace(/\.git$/, ''),
    };
  }

  return null;
}

function toProjectWebUrl(remoteUrl) {
  const parsed = parseSshOrHttpsRemote(remoteUrl);
  if (!parsed) {
    throw new Error(`Unable to parse remote URL: ${remoteUrl}`);
  }

  return `https://${parsed.host}/${parsed.path}`;
}

function findTopLevelReadme(repoPath) {
  const entries = fs.readdirSync(repoPath, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^readme(?:[.].+)?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => {
      const preferred = ['README.md', 'README.mdx', 'README.markdown', 'README.rst', 'README.txt', 'README'];
      const leftIndex = preferred.findIndex((name) => name.toLowerCase() === left.toLowerCase());
      const rightIndex = preferred.findIndex((name) => name.toLowerCase() === right.toLowerCase());
      const leftScore = leftIndex === -1 ? preferred.length : leftIndex;
      const rightScore = rightIndex === -1 ? preferred.length : rightIndex;
      return leftScore - rightScore || left.localeCompare(right);
    });

  return candidates[0] || null;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to parse config file ${CONFIG_PATH}: ${error.message}`);
  }
}

function buildBanner(projectUrl) {
  const config = loadConfig();
  const reason = process.env.GITHUB_MOVE_REASON || config.githubMoveReason || DEFAULT_REASON;
  return [
    BANNER_MARKER,
    `> This repository moved to [GitLab](${projectUrl}).`,
    '>',
    `> ${reason}`,
    '',
  ].join('\n');
}

function applyBanner(repoPath, projectUrl) {
  const readmeName = findTopLevelReadme(repoPath) || 'README.md';
  const readmePath = path.join(repoPath, readmeName);
  const banner = buildBanner(projectUrl);
  const original = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';

  if (original.includes(BANNER_MARKER)) {
    return { changed: false, readmePath };
  }

  const next = original ? `${banner}${original}` : `${banner}\n`;
  fs.writeFileSync(readmePath, next, 'utf8');
  return { changed: true, readmePath };
}

function commitAndPushGitHubMirror({ repoPath, branchName, localSha, gitlabUrl, dryRun }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlab-github-banner-'));
  const env = { ...process.env, [RECURSION_GUARD]: '1' };
  const userName =
    runQuiet('git', ['-C', repoPath, 'config', '--get', 'user.name']).stdout.trim() || 'gitlab migration hook';
  const userEmail =
    runQuiet('git', ['-C', repoPath, 'config', '--get', 'user.email']).stdout.trim() ||
    'gitlab-migration-hook@users.noreply.local';

  try {
    if (dryRun) {
      console.log(`[dry-run] git -C "${repoPath}" worktree add --detach "${tempRoot}" "${localSha}"`);
    } else {
      run('git', ['-C', repoPath, 'worktree', 'add', '--detach', tempRoot, localSha], { env });
    }

    const { changed, readmePath } = applyBanner(tempRoot, gitlabUrl);

    if (!changed) {
      console.log(`No GitHub banner change needed for ${path.basename(repoPath)} on ${branchName}`);
      return;
    }

    if (dryRun) {
      console.log(`[dry-run] add banner to ${readmePath}`);
      console.log(
        `[dry-run] git -C "${tempRoot}" commit -am "docs: point GitHub readers to GitLab" && git push --force github HEAD:refs/heads/${branchName}`,
      );
      return;
    }

    run('git', ['-C', tempRoot, 'add', path.basename(readmePath)], { env });
    run(
      'git',
      [
        '-C',
        tempRoot,
        '-c',
        `user.name=${userName}`,
        '-c',
        `user.email=${userEmail}`,
        'commit',
        '-m',
        'docs: point GitHub readers to GitLab',
      ],
      { env },
    );
    run('git', ['-C', tempRoot, 'push', '--force', 'github', `HEAD:refs/heads/${branchName}`], { env });
    console.log(`Updated GitHub branch ${branchName} with GitLab banner for ${path.basename(repoPath)}`);
  } finally {
    if (dryRun) {
      console.log(`[dry-run] git -C "${repoPath}" worktree remove --force "${tempRoot}"`);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } else {
      runQuiet('git', ['-C', repoPath, 'worktree', 'remove', '--force', tempRoot], { env });
      fs.rmSync(tempRoot, { recursive: true, force: true });
      runQuiet('git', ['-C', repoPath, 'worktree', 'prune'], { env });
    }
  }
}

function main() {
  if (process.env[RECURSION_GUARD] === '1') {
    process.exit(0);
  }

  const args = parseArgs(process.argv.slice(2));
  if (!args.repo || !args.remote) {
    process.exit(0);
  }

  if (args.remote !== 'origin') {
    process.exit(0);
  }

  const originUrl = args.url || runQuiet('git', ['-C', args.repo, 'remote', 'get-url', 'origin']).stdout.trim();
  const githubUrl = runQuiet('git', ['-C', args.repo, 'remote', 'get-url', 'github']).stdout.trim();

  if (!originUrl || !originUrl.includes('gitlab')) {
    process.exit(0);
  }

  if (!githubUrl || !githubUrl.includes('github.com')) {
    process.exit(0);
  }

  const stdin = fs.readFileSync(0, 'utf8');
  const refs = parseRefLines(stdin);

  for (const ref of refs) {
    if (!ref.localRef.startsWith('refs/heads/')) {
      continue;
    }

    if (isAllZeroSha(ref.localSha)) {
      continue;
    }

    const branchName = ref.localRef.replace(/^refs\/heads\//, '');
    commitAndPushGitHubMirror({
      repoPath: args.repo,
      branchName,
      localSha: ref.localSha,
      gitlabUrl: toProjectWebUrl(originUrl),
      dryRun: args.dryRun,
    });
  }
}

main();
