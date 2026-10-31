# Submission checklist

Read this once, top to bottom. The form takes **one** submission per team and it
**cannot be edited after sending**, so the order matters.

## What only a human can do

| # | Task | Who | Notes |
|---|---|---|---|
| 1 | Create a GitHub account | human | Free. Needed for the public repository. |
| 2 | Push the repository and make it **public** | human + agent | Must be public by **2026-11-14T23:59:00Z**; judges cannot open a private repo. |
| 3 | Record the demo and publish the X post | human | The post must say the project was built at NEAR HACKATHON and carry the video or screenshots. Draft text is in [`DEMO.md`](DEMO.md). |
| 4 | Fill `submission.json` | human | Name, email, team size, NEAR account for the payout, both links, the idea text, consent. |
| 5 | Run `node scripts/submit.mjs` and read the printed payload | human | Validates every field against the published contract. Nothing is sent without `--send`. |
| 6 | Send it | human | Type the project name to confirm, or paste the same JSON into the form at <https://nearhackathon.com/#apply>. |

The agent never pushes, never makes a repository public, never posts to X, and
never sends the submission without an explicit yes.

## Publishing the repository, three ways

The repository is already committed locally (clean worktree). Pick whichever is least
annoying; the only thing that matters is that the final URL is **public**.

**A. GitHub Desktop (no terminal).** Install GitHub Desktop, sign in, *File → Add local
repository*, choose the `veto` folder, then *Publish repository* and **uncheck** "Keep this
code private". Copy the URL it shows.

**B. Browser + git.** Create an empty repository `veto` on github.com (no README, no
licence), then:

```bash
git remote add origin https://github.com/<your-login>/veto.git
git push -u origin main
```

**C. With a fine-grained token.** If you hand the agent a GitHub token with `Contents: read
and write` on that one repository, it can create the repository and push for you. The token
is used once, never written to disk or into the repository, and should be revoked
afterwards. Your call - A and B need no secret sharing.

After publishing, open the URL in a private window to confirm it loads without a login.

Or let the preflight check it for you:

```bash
npm run preflight -- --published
```

That adds four rows to the usual 15: the repository is public, its default branch is `main`,
and the README is published. Until the repository exists those
rows fail, which is the correct answer.

## Fields that must come from the human, not from the agent

- **Lead name** and **email** - the email is unique across the hackathon.
- **NEAR mainnet account** for the payout. A named account (`team.near`) or a
  64-character implicit account. Never invented.
- **Team size**, exactly one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+`.
- **Consent**, only after reading the contact notice verbatim:
  *"I agree that the organizers may use these details to review our submission and
  contact us about this hackathon."*

## Tracks

The submission may name every track the project fits; it is still one submission.

- `security` - primary: spending limits, policy engines, sandboxed wallets,
  function-call keys.
- `agents` - secondary: agents that earn, spend and pay for services.

## Timing

| Date (UTC) | What |
|---|---|
| 2026-11-01 00:00 | Submissions open. Publish the repository in this window. |
| 2026-11-14 23:59 | Submission deadline **and** the moment the repository must be public. |
| 2026-11-16 .. 18 | Judging. |
| 2026-11-18 23:59 | Results announced. |

The submission API answers `403` outside the window; `scripts/submit.mjs` refuses
to send before `2026-11-01T00:00:00Z` for the same reason.

## Before publishing the repository

```bash
npm run preflight        # 16 checks: static consistency + every command exits 0
```

Green means the README's numbers are true, the demo assets are committed, the wasm matches
the hash quoted in the README, and no secret is tracked. If a line fails, fix it before the
repository goes public: judges and AI judges read the repo, not the intention.

## Before pressing send

```bash
node scripts/submit.mjs            # validates and prints the payload, sends nothing
```

Then confirm, by hand:

- [ ] the repository URL opens in a private browser window (public, not 404);
- [ ] the X post URL opens in a private window and says "built at NEAR HACKATHON";
- [ ] `npm run test:all` is green on a clean clone;
- [ ] the README's "try it in five minutes" steps were followed once, start to finish;
- [ ] the NEAR account in the payload is the one you control.

## If the API answers

| Status | Meaning | Action |
|---|---|---|
| 201 | Saved | Done. Keep the `requestId`. |
| 400 | A field failed validation | Fix the listed fields, re-run with the same `requestId`. |
| 403 | Not open yet, or cross-site | Do not retry; check the window. |
| 409 | Project name or email already used | Do not rename to dodge it; ask the organisers. |
| 413 | Body over 12,000 bytes | Shorten the idea field. |
| 503 | Storage unavailable | Wait a minute, re-run with the same `requestId`. |
