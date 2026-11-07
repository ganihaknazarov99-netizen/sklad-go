# Sklad Go

Stock and debt book for a small shop. Works in the browser on a phone or a computer,
also offline, in Russian and Tajik.

**I'm looking for an army of AI agents that runs this product on its own** — builds the
next features, tests them, guards them, and keeps the live shop healthy, while I run
the shop. This file is their brief: what the product is today, what it needs, what was
missed, what the next update is, and who does what.

## Live addresses

| Address | What it is |
|---|---|
| **https://app.skladgo.com** | the real shop — give this to sellers (since 7 Nov 2026) |
| https://skladgo.com | the introduction page (opens skladgo.com/about) |
| https://skladgo.vercel.app | the same shop, old address — keeps working (phones that saved it) |
| https://sklad-go-gani26.vercel.app | link for friends: sign up first, then their own empty warehouse on their phone only |

## How it runs

```
phone / browser ──► Vercel (app.skladgo.com)        static files from the repo root
                      │  /api/*, /auth/*  (rewrite, vercel.json)
                      ▼
                    Railway: service sklad-go        server/  (Node, npm start)
                      ▼
                    Railway Postgres                 rules: supabase/schema.sql (RLS)
```

- **Front end** — files in the repo root: `index.html`, `app.js`, `backend.js`,
  `backend-server.js`, `customer.js`, `mock.js`, `demo.js`, `merge.js`, `barcode.js`,
  `scan.js`, `qr.js`, `tg.js` (Tajik), `i18n.js`, `sw.js` (offline copy). No build step.
  `config.js` decides per address: real server, friends' phone-only mode, or demo.
- **Server** — `server/`: sign-in (Google, email + password, owner's app code),
  sessions in HttpOnly cookies, every request runs inside Postgres as that user so the
  access rules in `supabase/schema.sql` decide who sees what. Live updates over SSE.
  Backups of the data every 6 hours with restore.
- **Deploys** — merging into `main` deploys both: Vercel (front end) and Railway
  (server) pick it up by themselves in 1–3 minutes.
- **Domain** — skladgo.com was bought in Railway Domains; its DNS records live in the
  Railway dashboard (railway.com/workspace/domains), pointing at Vercel.

## What it does today

- Stock with sizes and colours, sale and arrival in one tap, day-by-day history
- Barcode scanner from the phone camera; "what to restock" list sent to WhatsApp
- Debts: who owes whom, part payments, due dates; written debts can't be rewritten
  later — the database itself refuses it
- Team: owner approves sellers; feed of changes; buyers see only their own debt
- Sign-in: Google or email + password; owner also needs a 6-digit code from an
  authenticator app; "sign out on all devices"
- Backups every 6 hours, owner can download a copy and restore
- Works offline and syncs when the internet is back; light and dark theme

## What I need, and what was missed

Ordered by how much it hurts if it goes wrong.

| # | Gap | Why it matters | Owner |
|---|---|---|---|
| 1 | **Railway is on the free trial** (≈28 days / $4.91 left on 6 Nov 2026) | when it runs out the server stops and the shop can't sign in. Needs the Hobby plan (~$5/month) | me |
| 2 | **No automatic tests on pull requests** | tests (270+) run only on a laptop; a broken change can reach the live shop | QA |
| 3 | **Nobody watches the live shop** | if the server goes down at night, I find out from a seller | QA / back end |
| 4 | **Backups live in the same Railway database** | if the Railway project is lost, the copies are lost with it. Need an off-site copy | back end |
| 5 | **Google branding not verified yet** | sign-in screen shows "skladgo.com" instead of the app name and logo; retry from 7 Nov evening | me + security |
| 6 | **Leftovers of the old setup** | Supabase code paths and CSP entries, the old full version in `frontend/`, `backend/src`, `deploy/` — confuse people and agents | front end / back end |
| 7 | **No error reports from phones** | when the app breaks on a seller's phone nobody sees the error | front end |
| 8 | **The "Assistant" tab is off** | it needs a Claude API key on the server, never in the page | back end |

## Next update

1. **Stability first:** tests on every pull request, an uptime check with an alert,
   an off-site backup copy, Railway plan.
2. **Clean-up:** remove Supabase leftovers and the old full version, tighten the
   content-security policy, keep one clear code path.
3. **Debt reminders:** a ready WhatsApp message to a buyer whose due date has passed.
4. **Reports:** sales and profit by day / week / month, export to Excel.
5. **Shops for other people:** real server accounts so a friend's warehouse is not
   tied to one phone (today it lives only in their browser).
6. **Assistant on the server:** questions like "what sold best this week" answered by
   Claude through the server, with the key kept in Railway.

## The agent team

Four leads own an area each; the specialists are called by them for narrow jobs.
Definitions live in [`.claude/agents/`](.claude/agents), the playbook in
[`.claude/skills/army-of-agents`](.claude/skills/army-of-agents/SKILL.md).

| Agent | Area | What it does |
|---|---|---|
| `frontend-developer` | everything in the repo root the phone loads | screens, offline copy, languages, phone-width layout |
| `backend-developer` | `server/`, `supabase/schema.sql` | API, sign-in, database rules, backups, deploy to Railway |
| `qa-engineer` | quality | runs the test suite, writes missing tests, checks screens and live addresses |
| `security-engineer` | cybersecurity | reviews every change like an attacker, audits headers, sessions, secrets, dependencies |
| `tester` | test suite | runs `backend/test`, knows why it hangs and how a skip lies |
| `screen-check` | eyes | opens the app at phone width and says in words what is wrong |
| `guard` | diff review | "what can a dishonest seller do now that they couldn't before?" |
| `languages` | dictionaries | keeps Russian / Tajik strings complete |
| `mirror-demo` | demo version | carries a change into the demo |
| `deploy-check` | live addresses | is each address up and serving fresh code |

### Rules every agent follows

1. **Work on a branch and open a pull request. Never merge into `main`** — merging
   deploys to the live shop, and only the owner says "merge".
2. **Every change ships with tests**, and the whole suite passes before the PR.
   A change to sign-in, sessions, roles, debts or the rules also gets a
   `security-engineer` review.
3. **No secrets anywhere** — not in code, commits, PRs or chat: database URL, Google
   client secret, tokens, passwords. Don't change Railway, Vercel or Google settings;
   ask the owner.
4. **Never touch the live database by hand.** Never re-run `srv.import_supabase`.
   Test against the local copy (`node server/dev.js`).
5. **Every new label exists in Russian and Tajik** (`tg.js`).
6. Keep `google710d239c76bd7e2b.html` — Google uses it to confirm the site is ours.
7. Commits and pull requests go only from the GitHub account
   `ganihaknazarov99-netizen`.
8. Report in plain words: what changed, how it was checked, what is still open.

## For developers

```bash
# local copy of the real shop (server + database in memory, demo data)
node server/dev.js            # → http://127.0.0.1:8787 — test logins are in the file header

# tests (Node 22.13+)
cd supabase && npm install    # once: PGlite, a Postgres for tests
cd backend && npm test
```

Server settings on Railway (`server/index.js` header): `DATABASE_URL`, `PUBLIC_URL`,
`EXTRA_ORIGINS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. The client secret is
typed in by the owner only.

**History.** Until 4 Nov 2026 the shop ran on Supabase; the setup guide for that is in
git history (`README.md` before this version). `frontend/`, `backend/src`,
`backend/server.js` and `deploy/` are an older "full version" that is not deployed.
