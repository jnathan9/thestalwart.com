# thestalwart.com

[Open the website](https://thestalwart.com/)

## Manage the site from any computer

This repository is the website's GitHub Pages source. GitHub serves the `main` branch from the repository root, with the custom domain `thestalwart.com` configured in `CNAME`. The website does not depend on any personal computer being awake.

Sign into the GitHub account with write access to this repository. Open a file and use GitHub's edit button, or press `.` on the repository page to open github.dev. Commit an intended site change to `main` to trigger publishing. For larger changes, work on a branch, review the diff and then merge when ready. Check the Pages build in Actions and confirm the changed page on the live site.

Keep `CNAME` and the domain's DNS configuration intact. Hosting or domain administration requires signing into the relevant GitHub/provider account; a local project folder does not contain those account permissions.

## Where things live

- `index.html`: main homepage.
- `meetyourneighbors/`: public Meet Your Neighbors viewer and contribution interface.
- `lange/`, `chatorclaude/`, `thestaiwart/`: published sub-sites.
- `Fedlock/` and `fedlock/`: distinct directory names in Git. Do not merge them accidentally on a filesystem that ignores letter case.
- `counter/`: service source; its Cloudflare deployment is separate from GitHub Pages.

A regular Windows/macOS checkout may collide on `Fedlock/` versus `fedlock/`. Browser editing works across platforms. For local editing, use a Linux filesystem or a sparse checkout of only the directory being changed; preserve both remote paths.

## Source and backend access

The Meet Your Neighbors development/research source is maintained separately in the owner's private `meet-your-neighbors` repository. The public folder here contains deployable browser assets, not private research or participant profiles. Its live map and contribution processing use a separate Cloudflare Pages/D1 service. Changing public HTML does not deploy a Worker or apply database migrations.

Lange's browser build and its coaching/analytics service are also separate. Keep API keys and backend credentials in the provider's secret settings, never in public JavaScript, HTML, commits or URL query strings.

For Codex work, open the appropriate source repository or website folder, describe the change and review it before publishing. GitHub provides the shared source/history; install development tools and authenticate provider accounts on each computer as needed.
