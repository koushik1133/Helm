# Secrets & credentials — never commit them

Helm scans every commit for secrets. This note says what not to commit, where
credentials belong instead, and how to run the scanner yourself.

## The rule

**Never commit a real or shared password — not even in docs, tester guides, SQL
seeds, HTML, or markdown tables.** A short human password (e.g. a shared
test-account password) is just as dangerous as an API key, and it stays in git
history forever even after you delete the line. This is exactly how a shared
staging password once leaked through an HTML tester guide.

That means no:

- `password: <word>` / `password = "..."` / `passwd: ...` in any file,
- plaintext passwords in `.sql` seeds (`create_..._user('a@b.com', 'secret', 'admin')`),
- "default / shared password is `...`" notes or login tables that pair an email
  with a password (`| admin@... | secret |`),
- real passwords, API keys, tokens, or Supabase `service_role` / `sb_secret_` /
  `sbp_` values anywhere in tracked files.

The **anon** Supabase keys in `public/config.js` / `public/config.staging.js` are
public-by-design (RLS-protected, `role=anon`) and are the only committed keys —
they are explicitly allowlisted in `.gitleaks.toml`.

## Where credentials belong instead

- **Local / server secrets** → the gitignored `.staging.env`, `.env`, `.env.e2e`
  (already in `.gitignore`), or the Supabase / Vercel dashboards. Never a tracked file.
- **Seed/test passwords** → generate them at seed time
  (`encode(gen_random_bytes(18), 'base64')`), do not hard-code a literal.
- **Sharing a credential with a teammate/tester** → send it out-of-band (password
  manager, 1:1 message), never in the repo. Document the *account email* and the
  *fact* that a password exists, not the value.

## What the scanner blocks

`.gitleaks.toml` extends the default gitleaks ruleset with Helm rules for
key-shaped secrets **and** human passwords:
`helm-password-assignment`, `helm-password-quoted-adjacent`,
`helm-seed-account-credential`, `helm-test-login-table`,
`helm-shared-default-password`, plus the earlier `helm-published-password` /
`helm-doc-password-plain` / Supabase-key rules.

Three layers run it:

1. **Pre-commit hook** (opt-in, local) — blocks the commit before it happens.
2. **CI gate** — `.github/workflows/secret-scan.yml` scans every push & PR and
   fails the build on any hit; a `gate` job depends on it.
3. **Weekly full-history scan** — `.github/workflows/secret-scan-history.yml`
   re-scans all history so a leak via force-push or an old branch is still caught.

## Install the local pre-commit hook (one command)

```sh
git config core.hooksPath .githooks
```

That points git at `.githooks/pre-commit`, which runs gitleaks on your **staged**
changes and blocks the commit if a credential is found. It is opt-in, so it is
not forced on anyone's machine. To turn it off: `git config --unset core.hooksPath`.

You need gitleaks installed: `brew install gitleaks` (macOS) or see
<https://github.com/gitleaks/gitleaks>.

## Run the scanner manually

```sh
# scan your staged changes (what the hook does)
gitleaks git -c .gitleaks.toml --staged --redact --no-banner

# scan the whole working tree
gitleaks detect -c .gitleaks.toml --no-git --redact --no-banner

# scan all git history
gitleaks git -c .gitleaks.toml --redact --no-banner
```

`--redact` keeps any detected secret out of your terminal and logs.

## Genuine false positive?

If a match is a real false positive (a fixture or placeholder, not a credential),
add a **fingerprint** to `.gitleaksignore` — the fingerprint is
`commit:file:rule:line` (history) or `file:rule:line` (tree) and contains **no
secret value**. Never commit the secret itself to silence the scanner.

## Already-leaked credentials

Removing a password from the current files does **not** remove it from git
history. If a real/shared password was ever committed, the fix is to **rotate the
affected accounts**, not to delete the line. Pending rotations are tracked in
`docs/OWNER-ACTIONS-SECURITY.md`.
