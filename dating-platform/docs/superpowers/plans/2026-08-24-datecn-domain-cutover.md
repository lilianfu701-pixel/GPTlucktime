# DateCN Domain Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point `datecn.org` and `www.datecn.org` to the verified free Vercel test deployment with HTTPS and a tested rollback path.

**Architecture:** Add both hostnames to the Vercel project first, obtain project-specific DNS requirements, then change only the two web records in Cloudflare. Keep Cloudflare nameservers, mail records, TXT records, and unrelated subdomains untouched.

**Tech Stack:** Vercel Domains, Cloudflare DNS, HTTPS/TLS, browser and DNS verification.

---

### Task 1: Capture the existing DNS state

**Files:**
- Create: `docs/deployment/datecn-dns-cutover-2026-08-24.md`

- [ ] **Step 1: Export the two web records**

Record the current values without changing them:

```text
datecn.org      A      178.128.54.40      Cloudflare proxied
www.datecn.org  A      178.128.54.40      Cloudflare proxied
```

Also record their actual TTL and confirm no `AAAA` or conflicting CNAME exists for either hostname.

- [ ] **Step 2: Record rollback criteria**

Rollback if Vercel cannot verify ownership, TLS is not issued, the homepage returns a non-2xx response, login callbacks use the wrong origin, or any required test flow fails after propagation.

### Task 2: Add the domains to Vercel before changing DNS

**Files:**
- Vercel project settings only.

- [ ] **Step 1: Add the apex domain**

In `datecn-free-test` → Settings → Domains, add `datecn.org` and set it as the primary production hostname.

- [ ] **Step 2: Add the www hostname**

Add `www.datecn.org` and configure a permanent redirect to `https://datecn.org` so cookies and canonical URLs use one origin.

- [ ] **Step 3: Copy the project-specific DNS requirements**

Use Vercel's domain inspection result. Record the exact apex A value, `www` CNAME target, and any ownership TXT value. Do not substitute generic documentation examples.

### Task 3: Present the final DNS diff and obtain cutover confirmation

**Files:**
- Modify: `docs/deployment/datecn-dns-cutover-2026-08-24.md`

- [ ] **Step 1: Prepare the exact change summary**

Show the user a two-row old/new table with record type, name, old value, new Vercel value, proxy state, TTL, and rollback value. State that unrelated DNS records will not be touched.

- [ ] **Step 2: Wait for explicit confirmation**

Do not click Cloudflare Save until the user confirms the displayed final DNS diff.

- [ ] **Step 3: Promote the canonical application origin**

Set `APP_URL=https://datecn.org` and `BETTER_AUTH_URL=https://datecn.org` for Production, redeploy the already verified commit, and confirm the new deployment is Ready before changing DNS. Keep the prior temporary-URL deployment available for rollback diagnostics.

### Task 4: Apply only the verified Cloudflare records

**Files:**
- Cloudflare DNS only.

- [ ] **Step 1: Set records to DNS-only during verification**

Replace the apex A record and the `www` record with Vercel's exact values, initially disabling the Cloudflare proxy so Vercel can observe the authoritative target directly. Preserve all mail, verification, and unrelated records.

- [ ] **Step 2: Verify Vercel ownership and certificate**

Refresh Vercel Domains until both hostnames show Valid Configuration and the certificate covers both names. Do not proceed on a warning state.

- [ ] **Step 3: Keep the supported proxy state**

Leave the records DNS-only unless Vercel's project-specific guidance explicitly confirms Cloudflare proxying is supported for this configuration.

### Task 5: Verify production and close the change

**Files:**
- Modify: `docs/deployment/datecn-dns-cutover-2026-08-24.md`

- [ ] **Step 1: Verify DNS and HTTPS**

Check multiple public resolvers for the apex and `www`, verify `https://datecn.org` has a valid certificate, and verify `https://www.datecn.org` redirects once to the apex without a loop.

- [ ] **Step 2: Run the production browser smoke test**

Verify `/zh`, `/en`, sign-in, registration test mailbox, member center, discovery, profile upload, and messages on desktop and mobile. Confirm auth cookies use the `datecn.org` origin.

- [ ] **Step 3: Roll back immediately on failure**

Restore both saved A records to `178.128.54.40` with their original proxy settings and TTL, then verify the pre-cutover response is restored. Keep the failed Vercel deployment available by its temporary URL for diagnosis.

- [ ] **Step 4: Record success and commit**

Record timestamps, final DNS values, certificate status, smoke-test results, and rollback readiness without secrets.

```text
git add docs/deployment/datecn-dns-cutover-2026-08-24.md
git commit -m "docs: record datecn.org Vercel cutover"
```
