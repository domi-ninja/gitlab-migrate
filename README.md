# gitlab-migrate

Small CommonJS scripts for migrating repositories from GitHub to GitLab.

## Files

- `migrate-repos.cjs`: migrates local repos and can optionally clone missing GitHub repos first
- `github-banner-sync.cjs`: post-push helper that updates the GitHub mirror README with a GitLab move notice
- `config.json`: configuration for the GitHub-side move blurb

## Notes

- diagnostics are written to `last-run.json`
- live run logs can be written to `last-live-run.log`
- those local runtime files are ignored by git
