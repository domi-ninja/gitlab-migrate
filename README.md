<!-- moved-to-codeberg -->
> This repository moved to [Codeberg](https://codeberg.org/domi-ninja/gitlab-migrate).
>
> I moved off GitHub because it became unreliable after the Microsoft acquisition.
# gitlab-migrate

Small CommonJS scripts for migrating repositories from GitHub to GitLab.

## What it does

- renames a GitHub `origin` remote to `github`
- creates or reuses a matching GitLab project
- adds GitLab as the new `origin`
- pushes the current branch
- installs a `post-push` hook that updates the GitHub mirror README with a GitLab move notice
- can also clone missing GitHub repos first, then migrate them

## Files

- `migrate-repos.cjs`: main migration script
- `github-banner-sync.cjs`: post-push helper for the GitHub-side README banner
- `config.json`: configuration for the GitHub-side move blurb

## Usage

Run in default mode:

```bash
node migrate-repos.cjs
```

That will:

1. clone missing GitHub repos from your account into the parent `repos` folder
2. migrate local repos to GitLab

Useful flags:

```bash
node migrate-repos.cjs --dry-run
node migrate-repos.cjs --no-clone-missing
node migrate-repos.cjs --clone-missing
node migrate-repos.cjs --namespace your-gitlab-namespace
node migrate-repos.cjs --github-owner your-github-user
```

## Config

Edit `config.json` to change the GitHub banner text:

```json
{
  "githubMoveReason": "We moved off GitHub because it became unreliable after the Microsoft acquisition."
}
```

## Notes

- diagnostics are written to `last-run.json`
- live run logs can be written to `last-live-run.log`
- those local runtime files are ignored by git
