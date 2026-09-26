# SPDX-License-Identifier: MIT
# ============================================================
# MARKETPLACE SKILLS — EXTERNAL INGESTION (Phase 3 of marketplace_skills_plan.md)
#
# Two-layer gate before any source is ever fetched:
#   Layer 1: core.config.MARKETPLACE_SKILL_INGESTION_ENABLED (master) +
#            MARKETPLACE_SOURCE_FLAGS[org/repo] (per-site) — both env-driven,
#            deploy-time.
#   Layer 2: db.models.MarketplaceSourceConfigRecord row, enabled=True —
#            runtime, admin-adjustable.
#
# Trust anchoring (plan §3.3): the immutable GitHub org id is checked, not
# just the login string (an impersonating account could rename itself to
# match a login, but not its numeric id); content is pinned to one exact
# commit SHA per ingestion pass (never "latest branch tip", so content can't
# silently change after review); every folder's license is re-fetched and
# re-classified every cycle, never assumed from a cached value; an anomaly
# circuit-breaker halts (does not apply) a sync that looks suspicious.
#
# Standalone from routers/skills_router.py and routers/marketplace_router.py —
# same separation as the rest of this feature. Only ever writes to
# marketplace_source_configs_pg (DB) and its own KV cache DB
# (core.config.RDB_MARKETPLACE_SKILLS) — NOT marketplace_skills_pg. Browsing
# a not-yet-installed third-party skill reads from the cache; a skill only
# gets a permanent marketplace_skills_pg row the moment a real user installs
# it (routers/marketplace_skills_router.py's install_marketplace_skill),
# confirmed design per marketplace_skills_plan.md's "browse vs. store" round —
# this project deliberately does not keep a durable copy of third-party
# content nobody has chosen to use.
# ============================================================

import base64
import json
import re
from datetime import datetime, timedelta

import httpx
from sqlalchemy.exc import IntegrityError

from core.logger import logger
from core.config import MARKETPLACE_SKILL_INGESTION_ENABLED, MARKETPLACE_SOURCE_FLAGS, RDB_MARKETPLACE_SKILLS
from core.kv import get_kv, KVError
from db.database import SessionLocal
from db.models import MarketplaceSourceConfigRecord, MarketplaceSkillRecord
from services.skill_security_scan import resolve_security_status

GITHUB_API = "https://api.github.com"

_kv = None


def _get_kv():
    """Cached KV client for the third-party browse cache (own DB, see
    core.config.RDB_MARKETPLACE_SKILLS) — same lazy-connect-and-cache pattern
    as routers/marketplace_router.py's `_get_redis()`, deliberately a
    separate DB/instance from that router's own registry."""
    global _kv
    if _kv is None:
        try:
            c = get_kv(RDB_MARKETPLACE_SKILLS, decode_responses=True)
            c.ping()
            _kv = c
        except KVError as e:
            logger.warning(f"marketplace-ingestion: KV backend unavailable — {e}")
    return _kv


def _cache_key(org_login: str, repo_name: str) -> str:
    return f"mkt:thirdparty:{org_login}/{repo_name}"


def _browse_id(org_login: str, repo_name: str, folder: str) -> str:
    """Stable synthetic id for a cached-but-not-yet-installed skill — used as
    its `id` in browse responses since it has no Postgres row (and thus no
    real UUID) yet. Never persisted; only meaningful as a lookup key back
    into the cache. Base64url-encoded (not a plain "org/repo:folder" string)
    specifically because `folder` itself always contains a literal "/"
    (GitHub paths are "skills/<name>") — a raw slash in this id would break
    FastAPI's default `{skill_id}` path-param matching, which stops at the
    first "/". Base64url's alphabet has none, so this is always one clean
    path segment no matter what the frontend does with it.
    """
    payload = f"{org_login}/{repo_name}:{folder}"
    return "tp." + base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def parse_browse_id(browse_id: str):
    """Inverse of _browse_id(). Returns (org_login, repo_name, folder) or
    None if `browse_id` isn't one of ours (e.g. it's a real Postgres UUID)."""
    if not browse_id or not browse_id.startswith("tp."):
        return None
    token = browse_id[3:]
    padded = token + "=" * (-len(token) % 4)
    try:
        payload = base64.urlsafe_b64decode(padded.encode()).decode()
    except Exception:
        return None
    org_repo, sep, folder = payload.partition(":")
    org_login, sep2, repo_name = org_repo.partition("/")
    if not (sep and sep2 and org_login and repo_name and folder):
        return None
    return org_login, repo_name, folder

# ── License compatibility, reasoned explicitly against THIS project's own
# MIT license (confirmed requirement: we are an MIT-licensed open-source
# project, so any third-party skill content we redistribute must carry a
# license that's actually compatible with that — permissive, no copyleft/
# share-alike/non-commercial obligations that would conflict with our own
# MIT terms). This is deliberately a real compatibility judgment, not just
# "is there some license file" — see classify_license()'s docstring.
#
# Order matters for BSD: 3-Clause's marker set is checked before 2-Clause's,
# because 3-Clause license text also contains 2-Clause's simpler marker
# phrase — checking 2-Clause first would misclassify real 3-Clause text.
MIT_COMPATIBLE_LICENSES = {
    "MIT":          ["Permission is hereby granted, free of charge"],
    "Apache-2.0":   ["Apache License", "Version 2.0"],
    "BSD-3-Clause": ["Redistribution and use in source and binary forms", "Neither the name"],
    "BSD-2-Clause": ["Redistribution and use in source and binary forms"],
    "ISC":          ["Permission to use, copy, modify, and/or distribute this software"],
}

# Recognized as explicitly INCOMPATIBLE with redistribution inside an MIT
# project — copyleft (share-alike obligations MIT can't satisfy), non-
# commercial clauses, or an outright proprietary/all-rights-reserved grant
# (the exact pattern confirmed on anthropics/skills' docx/pdf/pptx/xlsx
# folders — see marketplace_skills_plan.md Phase 3 §3.1). Logged with a
# specific reason rather than a generic "no match", so a skipped skill's
# audit trail says *why* it was rejected, not just *that* it was.
_INCOMPATIBLE_LICENSE_MARKERS = {
    "GPL":                 ["GNU GENERAL PUBLIC LICENSE"],
    "AGPL":                ["GNU AFFERO GENERAL PUBLIC LICENSE"],
    "LGPL":                ["GNU LESSER GENERAL PUBLIC LICENSE"],
    "CC-BY-NC":            ["NonCommercial", "CC BY-NC"],
    "CC-BY-SA":            ["ShareAlike", "CC BY-SA"],
    "All-Rights-Reserved": ["All rights reserved", "ADDITIONAL RESTRICTIONS"],
}


def _gh_get(path: str, timeout: float = 15):
    r = httpx.get(
        f"{GITHUB_API}{path}",
        headers={"User-Agent": "ainxt-marketplace-ingestion", "Accept": "application/vnd.github+json"},
        timeout=timeout,
    )
    r.raise_for_status()
    return r.json()


def _gh_raw(owner: str, repo: str, ref: str, path: str, timeout: float = 15):
    """Fetch a raw file at a pinned ref (commit SHA, not a branch name)."""
    url = f"https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}"
    r = httpx.get(url, timeout=timeout)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.text


def classify_license(license_text):
    """Classify a LICENSE.txt against MIT-compatibility, not just "is there
    a license". Returns (license_id, None) if it's one of
    MIT_COMPATIBLE_LICENSES; otherwise (None, reason) where `reason` is a
    human-readable explanation — a real incompatible license detected by
    name, or "no license file" / "unrecognized" for anything else. Callers
    must treat `license_id is None` as "do not ingest/allow", period.
    """
    if not license_text:
        return None, "no LICENSE.txt found"
    for lic_id, markers in MIT_COMPATIBLE_LICENSES.items():
        if all(m in license_text for m in markers):
            return lic_id, None
    for bad_id, markers in _INCOMPATIBLE_LICENSE_MARKERS.items():
        if any(m in license_text for m in markers):
            return None, f"detected {bad_id} — not compatible with this project's MIT license"
    return None, "license text present but not a recognized MIT-compatible license"


def is_mit_compatible_license(license_id) -> bool:
    """Defense-in-depth check usable anywhere a *stored* `license` value
    needs re-validating (e.g. at install time) — not just at ingestion."""
    return license_id in MIT_COMPATIBLE_LICENSES


def parse_skill_md(raw: str):
    """Minimal SKILL.md frontmatter parser — mirrors ai-ui/src/marketplaceStore.js's
    parseSkillMarkdown, including the same name<=64/description<=200 limits."""
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?(.*)$", raw, re.DOTALL)
    if not m:
        return None
    fm_raw, body = m.groups()
    fm = {}
    for line in fm_raw.splitlines():
        lm = re.match(r"^([a-zA-Z_-]+):\s*(.*)$", line)
        if lm:
            fm[lm.group(1).strip()] = lm.group(2).strip().strip("\"'")
    name = fm.get("name")
    description = fm.get("description")
    if not name or not description or not body.strip():
        return None
    return {"name": name[:64], "description": description[:200], "instructions": body.strip()}


def ingest_github_skills_repo(config: MarketplaceSourceConfigRecord, db) -> str:
    """Generic ingestor for ANY GitHub-hosted repo following the Agent Skills
    convention (skills/<name>/SKILL.md + a LICENSE.txt per folder) — not
    specific to Anthropic. Every field this function reads (`org_login`,
    `repo_name`, `org_id`, `allowed_licenses`, `anomaly_threshold_pct`) comes
    from the `config` row, so the exact same function ingests
    `anthropics/skills` today and would ingest `openai/skills`,
    `huggingface/skills`, `NVIDIA/skills`, or `ComposioHQ/awesome-claude-skills`
    identically, once each has been independently verified (§3.3) and given
    its own config row — see _INGESTORS below for how a new source gets
    wired in without writing a new ingestor function.

    IMPORTANT (confirmed design, see marketplace_skills_plan.md Phase 3
    "browse vs. store" decision): this function does NOT write to the
    permanent `marketplace_skills_pg` catalog table. It writes the
    license/security-classified result to a short-lived KV cache instead —
    that cache is what browsing reads from (routers/marketplace_skills_router.py's
    `_browse_thirdparty_cache`). A skill only ever gets a real row in the
    permanent catalog the moment a user actually installs it (see
    `install_marketplace_skill`), which re-fetches and re-verifies that one
    specific skill live, at its pinned commit, rather than trusting this
    cache. This keeps "we ingested it" and "we're persistently storing a
    copy of someone else's content" as two separate events — we only keep a
    durable copy of third-party content a real user chose to use.

    `db` is accepted for interface symmetry with other ingestors (all keyed
    the same way in _INGESTORS) but is not queried/written here — nothing
    for this function to persist in Postgres anymore.

    Returns a status string stored on the config row:
    ok | halted_owner_mismatch | halted_anomaly | error.
    """
    owner, repo = config.org_login, config.repo_name

    try:
        repo_data = _gh_get(f"/repos/{owner}/{repo}")
    except Exception as e:
        logger.warning(f"[marketplace-ingestion] {owner}/{repo}: repo fetch failed: {e}")
        return "error"

    # ── Trust anchor: the immutable org id, not just the login string ──
    if repo_data.get("owner", {}).get("id") != config.org_id:
        logger.warning(f"[marketplace-ingestion] {owner}/{repo}: owner id mismatch (expected {config.org_id}, "
                        f"got {repo_data.get('owner', {}).get('id')}) — halting, not auto-applying")
        return "halted_owner_mismatch"

    default_branch = repo_data.get("default_branch", "main")
    try:
        commit_sha = _gh_get(f"/repos/{owner}/{repo}/commits/{default_branch}")["sha"]
    except Exception as e:
        logger.warning(f"[marketplace-ingestion] {owner}/{repo}: commit lookup failed: {e}")
        return "error"

    try:
        tree = _gh_get(f"/repos/{owner}/{repo}/git/trees/{commit_sha}?recursive=1")
    except Exception as e:
        logger.warning(f"[marketplace-ingestion] {owner}/{repo}: tree fetch failed: {e}")
        return "error"

    skill_md_paths = [
        item["path"] for item in tree.get("tree", [])
        if item.get("type") == "blob" and item["path"].startswith("skills/") and item["path"].endswith("/SKILL.md")
    ]

    kv = _get_kv()
    cache_key = _cache_key(owner, repo)
    previous_raw = kv.get(cache_key) if kv else None
    try:
        previous = json.loads(previous_raw) if previous_raw else []
    except (TypeError, ValueError):
        previous = []
    previous_by_name = {s["name"]: s for s in previous if isinstance(s, dict) and "name" in s}

    # Skills someone has already installed have a real, permanent Postgres
    # row (routers/marketplace_skills_router.py's install_marketplace_skill)
    # and are served from there — re-adding them to the cache too would just
    # be a duplicate copy of the same content sitting in two places for no
    # reason. This is a read-only lookup (this function still never WRITES
    # to marketplace_skills_pg); keeps the cache's contents matching its own
    # name — "not yet installed by anyone" — rather than "everything,
    # regardless of install state" and relying only on the browse
    # endpoint's de-dupe to hide the overlap.
    already_installed_names = {
        row[0] for row in db.query(MarketplaceSkillRecord.name).filter(
            MarketplaceSkillRecord.source == f"{owner}/{repo}"
        ).all()
    }

    cached_list = []
    skipped_license = 0
    new_count = 0
    # Only a MEANINGFUL content/license change counts toward the anomaly
    # circuit-breaker below — re-touching every existing entry on every
    # routine sync (refreshing metadata that's actually identical, or
    # re-scanning with an updated scanner rule) is normal steady-state
    # behavior, not an anomaly. Conflating "touched" with "changed" would
    # trip the breaker on almost every sync after the first one, which
    # defeats its purpose (caught by real-world testing against the live
    # anthropics/skills repo — see the git history/commit message for this
    # fix if this comment ever goes stale). Baseline is the PREVIOUS cache
    # contents now, not a Postgres row count — nothing is persisted here
    # anymore for the breaker to compare against.
    meaningfully_changed = 0
    for md_path in skill_md_paths:
        folder = md_path.rsplit("/SKILL.md", 1)[0]
        # Per-folder license re-fetched and re-classified EVERY cycle — never
        # cached/assumed, per the plan's explicit requirement (§3.1 conclusion).
        # classify_license() judges actual MIT-compatibility, not just "is
        # there a license file" — see its docstring for what that means.
        license_text = _gh_raw(owner, repo, commit_sha, f"{folder}/LICENSE.txt")
        lic_id, skip_reason = classify_license(license_text)
        if not lic_id or lic_id not in (config.allowed_licenses or []):
            skipped_license += 1
            if skip_reason:
                logger.info(f"[marketplace-ingestion] {owner}/{repo}/{folder}: skipped — {skip_reason}")
            continue

        md_content = _gh_raw(owner, repo, commit_sha, md_path)
        if not md_content:
            continue
        parsed = parse_skill_md(md_content)
        if not parsed:
            continue

        if parsed["name"] in already_installed_names:
            continue   # already has a real, permanent row — served from there, not duplicated into the cache

        source_ref = f"{folder}@{commit_sha}"
        security_status = resolve_security_status(True, f"{owner}/{repo}", parsed["instructions"], [])

        prev = previous_by_name.get(parsed["name"])
        if prev:
            if (prev.get("description") != parsed["description"]
                    or prev.get("instructions") != parsed["instructions"]
                    or prev.get("license") != lic_id):
                meaningfully_changed += 1
        else:
            new_count += 1

        # Shaped exactly like routers/marketplace_skills_router.py's
        # _row_to_dict() output, so the browse endpoint can merge cached and
        # real-Postgres skills into one list with no per-entry remapping.
        cached_list.append({
            "id": _browse_id(owner, repo, folder),
            "name": parsed["name"], "description": parsed["description"],
            "category": "", "icon": "\U0001F916", "tags": [],
            "instructions": parsed["instructions"], "files": [],
            "version": 1, "installs": 0, "author": owner,
            "thirdParty": True, "createdAt": None, "updatedAt": None, "installed": False,
            "source": f"{owner}/{repo}", "source_ref": source_ref,
            "license": lic_id, "securityStatus": security_status,
        })

    # ── Anomaly circuit-breaker: don't auto-apply a suspiciously large change ──
    # Measures new-skills-appeared + meaningfully-changed-content against the
    # PREVIOUS cache size — NOT every entry merely touched this pass.
    significant = new_count + meaningfully_changed
    baseline = len(previous)
    if baseline > 3:
        changed_pct = int(100 * significant / baseline)
        if changed_pct > (config.anomaly_threshold_pct or 20):
            logger.warning(f"[marketplace-ingestion] {owner}/{repo}: {changed_pct}% significant change "
                            f"({new_count} new, {meaningfully_changed} changed) vs {baseline} previously cached "
                            f"exceeds {config.anomaly_threshold_pct}% threshold — halting, not overwriting cache")
            return "halted_anomaly"

    if not kv:
        logger.warning(f"[marketplace-ingestion] {owner}/{repo}: no KV/cache backend available — skipping")
        return "error"

    ttl_seconds = max(config.sync_interval_minutes or 720, 60) * 60 * 3   # survive a couple of missed cycles, not forever
    kv.setex(cache_key, ttl_seconds, json.dumps(cached_list))
    logger.info(f"[marketplace-ingestion] {owner}/{repo}: cached {len(cached_list)} browsable skills "
                f"({new_count} new, {meaningfully_changed} changed), skipped {skipped_license} (license)")
    return "ok"


def browse_thirdparty_skills(source_keys) -> list:
    """Read-only: return the cached browse list for every `org/repo` in
    `source_keys` (already filtered by the caller to sources that are
    Layer-1 + Layer-2 enabled — a disabled source's cache is never read,
    even if its TTL hasn't expired, so turning a source off stops it from
    appearing in Marketplace immediately, not just stops future ingestion).
    Never touches Postgres; the caller (routers/marketplace_skills_router.py)
    is responsible for de-duplicating against real catalog rows (a skill
    that's already been installed by someone has a real row and should be
    shown from there instead, with its real id/installs count)."""
    kv = _get_kv()
    if not kv:
        return []
    out = []
    for key in source_keys:
        org_login, _, repo_name = key.partition("/")
        raw = kv.get(_cache_key(org_login, repo_name))
        if not raw:
            continue
        try:
            out.extend(json.loads(raw))
        except (TypeError, ValueError):
            continue
    return out


def get_cached_thirdparty_skill(browse_id: str):
    """Look up one cached skill by its synthetic browse id. Returns the
    cached dict or None (not found / cache expired / source's cache key
    doesn't parse)."""
    parsed = parse_browse_id(browse_id)
    if not parsed:
        return None
    org_login, repo_name, folder = parsed
    kv = _get_kv()
    if not kv:
        return None
    raw = kv.get(_cache_key(org_login, repo_name))
    if not raw:
        return None
    try:
        entries = json.loads(raw)
    except (TypeError, ValueError):
        return None
    for entry in entries:
        if entry.get("id") == browse_id:
            return entry
    return None


def refetch_and_verify_skill(browse_id: str, allowed_licenses):
    """Install-time re-verification for a cached (not-yet-permanent) skill —
    never trusts the cache's own license/security fields for the actual
    decision, re-fetches LICENSE.txt + SKILL.md live at the EXACT commit
    pinned in the cache entry's source_ref (never "latest", so this can't
    silently pick up an upstream change between caching and install — a
    changed upstream is only ever picked up on the NEXT ingestion cycle, at
    a new pin, same as today) and re-classifies from scratch. Returns a dict
    shaped like a cache entry, or None if the skill can no longer be
    positively verified (cache gone, commit/folder gone upstream, or its
    license is no longer in `allowed_licenses`) — caller must treat None as
    "refuse the install", not fall back to trusting the cache."""
    cached = get_cached_thirdparty_skill(browse_id)
    if not cached:
        return None
    org_login, repo_name, folder = parse_browse_id(browse_id)
    source_ref = cached.get("source_ref") or ""
    _, _, commit_sha = source_ref.partition("@")
    if not commit_sha:
        return None

    try:
        license_text = _gh_raw(org_login, repo_name, commit_sha, f"{folder}/LICENSE.txt")
    except Exception as e:
        logger.warning(f"[marketplace-install-verify] {browse_id}: license re-fetch failed: {e}")
        return None
    lic_id, skip_reason = classify_license(license_text)
    if not lic_id or lic_id not in (allowed_licenses or []):
        logger.info(f"[marketplace-install-verify] {browse_id}: rejected at install — {skip_reason or 'license not allowed'}")
        return None

    try:
        md_content = _gh_raw(org_login, repo_name, commit_sha, f"{folder}/SKILL.md")
    except Exception as e:
        logger.warning(f"[marketplace-install-verify] {browse_id}: SKILL.md re-fetch failed: {e}")
        return None
    parsed = parse_skill_md(md_content) if md_content else None
    if not parsed:
        return None

    security_status = resolve_security_status(True, f"{org_login}/{repo_name}", parsed["instructions"], [])
    return {
        "name": parsed["name"], "description": parsed["description"], "instructions": parsed["instructions"],
        "author": org_login, "source": f"{org_login}/{repo_name}", "source_ref": source_ref,
        "license": lic_id, "securityStatus": security_status,
    }


# Every researched GitHub-hosted source (plan §3.4's table) maps to the SAME
# generic ingest_github_skills_repo — they all follow the same Agent Skills
# folder convention, so there is no per-site ingestion code to write. Being
# listed here is NOT the same as being usable: a source only actually gets
# fetched once (1) MARKETPLACE_SOURCE_FLAGS[source_key] is true (core/config.py,
# env, deploy-time) AND (2) a MarketplaceSourceConfigRecord row exists for it
# with enabled=True (DB, admin, runtime) — see run_ingestion_cycle() below.
# Today only "anthropics/skills" has been independently verified (org id,
# license structure — plan §3.1) and given a config row; the other four are
# listed so the *mechanism* is honestly multi-source-ready, not because
# they're safe to enable yet — each needs its own §3.3 verification pass
# and its own config row (with a verified org_id) before its env flag means
# anything. Adding a genuinely new, not-yet-researched source would still
# need its own entry here, but "new site, same GitHub convention" never
# needs a new function — that was the whole point of parameterizing
# ingest_github_skills_repo by `config` instead of hardcoding a repo name
# into it.
_INGESTORS = {
    "anthropics/skills":                ingest_github_skills_repo,
    "openai/skills":                    ingest_github_skills_repo,
    "huggingface/skills":               ingest_github_skills_repo,
    "NVIDIA/skills":                     ingest_github_skills_repo,
    "ComposioHQ/awesome-claude-skills":  ingest_github_skills_repo,
}


def enabled_thirdparty_sources(db) -> list:
    """Sources currently allowed at BOTH layers (env flag AND DB
    `enabled=True`) — same gating `run_ingestion_cycle` applies before ever
    fetching a source, reused here so the browse endpoint shows a source's
    cache if and only if that source is still actually enabled. Returns the
    `MarketplaceSourceConfigRecord` rows themselves (caller needs
    `allowed_licenses` too, not just the org/repo key)."""
    configs = db.query(MarketplaceSourceConfigRecord).filter(
        MarketplaceSourceConfigRecord.enabled == True  # noqa: E712
    ).all()
    return [c for c in configs if MARKETPLACE_SOURCE_FLAGS.get(f"{c.org_login}/{c.repo_name}")]


# How often gateway.py's scheduler actually calls run_ingestion_cycle().
# This is deliberately much smaller than any source's own sync_interval_minutes
# (default 720) — it's just the "how often do we check whether anything is
# due" tick, not the fetch cadence itself. Each source's OWN interval is what
# actually paces its own fetches (see run_ingestion_cycle below); this only
# needs to be fine-grained enough that a short custom interval (an admin
# could set one to e.g. 60 via PATCH /marketplace-source-configs/{id}) isn't
# silently rounded up to whatever this tick happens to be.
INGESTION_SCHEDULER_TICK_MINUTES = 15


def run_ingestion_cycle():
    """Top-level entrypoint — called on a schedule (see gateway.py startup),
    every INGESTION_SCHEDULER_TICK_MINUTES. Each enabled source is only
    actually re-fetched if its OWN `sync_interval_minutes` has elapsed since
    `last_synced_at` — this function fires often, but most calls are a cheap
    timestamp check that skips every source, not a real GitHub fetch."""
    if not MARKETPLACE_SKILL_INGESTION_ENABLED:
        return
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        for config in enabled_thirdparty_sources(db):
            interval = timedelta(minutes=config.sync_interval_minutes or 720)
            if config.last_synced_at and (now - config.last_synced_at) < interval:
                continue   # not due yet — this source's own interval governs this, not the scheduler tick
            source_key = f"{config.org_login}/{config.repo_name}"
            ingestor = _INGESTORS.get(source_key)
            status = ingestor(config, db) if ingestor else "error"
            config.last_sync_status = status
            config.last_synced_at = now
            db.commit()
    except Exception as e:
        logger.warning(f"run_ingestion_cycle failed: {e}")
    finally:
        db.close()


# Every researched, GitHub-hosted, `org/repo`-shaped source from plan §3.4's
# table gets a row here — being seeded is what makes a source's env flag
# (MARKETPLACE_SOURCE_FLAGS) and the admin PATCH endpoint actually mean
# something; a source with no row here can't be turned on by either layer
# no matter what its env flag says (see run_ingestion_cycle()). `org_id` is
# each org's real, immutable GitHub numeric id (fetched directly from
# `GET /orgs/{login}`, not guessed), for the trust-anchoring check in
# ingest_github_skills_repo (plan §3.3).
#
# Only anthropics/skills has had its actual per-skill-folder license layout
# independently verified end-to-end (plan §3.1) — the other four are real,
# existing, publicly-accessible repos (confirmed to exist, confirmed org
# ids), but their exact license-file layout hasn't been individually
# checked against this ingestor's per-folder `{folder}/LICENSE.txt` fetch.
# That's a safe gap, not a silent one: if a repo's licensing doesn't match
# that convention, classify_license() just sees "no license file" for every
# skill and skips all of them (fail-safe — never a false "compatible"), so
# turning one of these on is safe to try, it may just ingest zero skills
# until that convention is confirmed for that specific repo.
_SEED_SOURCES = [
    # (org_login, org_id, repo_name)
    ("anthropics", 76263028,  "skills"),
    ("openai",     14957082,  "skills"),
    ("huggingface", 25720743, "skills"),
    ("NVIDIA",     1728152,   "skills"),
    ("ComposioHQ", 128464815, "awesome-claude-skills"),
]


def seed_marketplace_source_configs():
    """Idempotent seed: one row per known source (plan §3.4), `enabled=False`
    by default for every one of them — an admin must explicitly turn a
    source on even if its env flag also allows it (both layers must agree).
    Called once at gateway startup, same pattern as seed_marketplace_skills.
    Turning a source off later (malware report, site unreachable, license
    policy change) is a config-only operation from here on: flip its env
    flag off (redeploy) and/or PATCH its row's `enabled` to false (instant,
    no redeploy) — never a code change, since every source shares the same
    generic ingestor.
    """
    db = SessionLocal()
    try:
        for org_login, org_id, repo_name in _SEED_SOURCES:
            existing = db.query(MarketplaceSourceConfigRecord).filter(
                MarketplaceSourceConfigRecord.org_login == org_login,
                MarketplaceSourceConfigRecord.repo_name == repo_name,
            ).first()
            if existing:
                continue
            db.add(MarketplaceSourceConfigRecord(
                org_login=org_login, org_id=org_id, repo_name=repo_name,
                enabled=False, allowed_licenses=list(MIT_COMPATIBLE_LICENSES.keys()),
                sync_interval_minutes=720, anomaly_threshold_pct=20,
                created_by=None,
            ))
            try:
                db.commit()
            except IntegrityError:
                # Another gunicorn worker's startup event won the race and
                # already inserted this org/repo — not an error.
                db.rollback()
    except Exception as e:
        db.rollback()
        logger.warning(f"seed_marketplace_source_configs: {e}")
    finally:
        db.close()
