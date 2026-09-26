# SPDX-License-Identifier: MIT
# ============================================================
# MARKETPLACE SKILLS ROUTER — /marketplace-skills  (Postgres-native)
#
# Standalone from routers/skills_router.py (SkillRecord/skills_pg, the
# governance/proposal system) and from routers/marketplace_router.py (the
# Redis/KV-backed MCP tool registry). Deliberately separate — see
# ai-ui/src/marketplaceStore.js header for why. Do not import from or write
# to either of those two systems here.
# ============================================================

from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from core.logger import logger
from auth.dependencies import get_current_user, require_admin
from db.database import get_db, SessionLocal
from db.models import MarketplaceSkillRecord, MarketplaceSkillInstallRecord, MarketplaceSourceConfigRecord
from services.skill_security_scan import scan_and_update
from services.marketplace_skill_ingestion import (
    MIT_COMPATIBLE_LICENSES, is_mit_compatible_license,
    enabled_thirdparty_sources, browse_thirdparty_skills, get_cached_thirdparty_skill,
    refetch_and_verify_skill, parse_browse_id,
)

router = APIRouter(tags=["marketplace-skills"])


# ============================================================
# HELPERS
# ============================================================

def _row_to_dict(r: MarketplaceSkillRecord, installed: bool) -> dict:
    return {
        "id": r.id,
        "name": r.name,
        "description": r.description or "",
        "category": r.category or "",
        "icon": r.icon or "",
        "tags": r.tags or [],
        "instructions": r.instructions or "",
        "files": r.files or [],
        "version": r.version,
        "installs": r.installs,
        "author": r.author or "",
        "thirdParty": bool(r.third_party),
        "createdAt": int(r.created_at.timestamp() * 1000) if r.created_at else None,
        "updatedAt": int(r.updated_at.timestamp() * 1000) if r.updated_at else None,
        "installed": installed,
        "source": r.source or "internal",
        "license": r.license,
        "securityStatus": r.security_status,
    }


def _current_user_id(current_user: dict) -> str:
    return str(current_user.get("sub") or current_user.get("id") or "")


def _is_owner_or_admin(record: MarketplaceSkillRecord, current_user: dict) -> bool:
    if current_user.get("role") == "admin":
        return True
    return bool(record.created_by) and record.created_by == _current_user_id(current_user)


def _installed_ids(db: Session, user_id: str) -> set:
    rows = db.query(MarketplaceSkillInstallRecord.skill_id).filter(
        MarketplaceSkillInstallRecord.user_id == user_id
    ).all()
    return {row[0] for row in rows}


# ============================================================
# PYDANTIC
# ============================================================

class MarketplaceSkillCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    description: str = Field(..., min_length=1, max_length=200)
    category: str = ""
    icon: str = ""
    tags: List[str] = []
    instructions: str = Field(..., min_length=1)
    files: List[dict] = []


class MarketplaceSkillUpdate(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    description: str = Field(..., min_length=1, max_length=200)
    category: str = ""
    icon: str = ""
    tags: List[str] = []
    instructions: str = Field(..., min_length=1)
    files: List[dict] = []


class MarketplaceSkillUploadEntry(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    description: str = Field(..., min_length=1, max_length=200)
    instructions: str = Field(..., min_length=1)
    files: List[dict] = []


class MarketplaceSkillUploadRequest(BaseModel):
    skills: List[MarketplaceSkillUploadEntry]


# ============================================================
# ENDPOINTS
# ============================================================

@router.get("/marketplace-skills")
def list_marketplace_skills(current_user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    user_id = _current_user_id(current_user)
    installed = _installed_ids(db, user_id)
    rows = db.query(MarketplaceSkillRecord).order_by(MarketplaceSkillRecord.name.asc()).all()
    skills = [_row_to_dict(r, r.id in installed) for r in rows]

    # Not-yet-installed third-party skills: browse-only, read from the KV
    # cache (services/marketplace_skill_ingestion.py), never from Postgres —
    # see marketplace_skills_plan.md's "browse vs. store" decision. A skill
    # that's already been installed by someone has a real row above already
    # (with its real id/installs count); de-dupe by (source, name) so it's
    # never shown twice.
    already_have = {(r.source, r.name) for r in rows}
    source_keys = [f"{c.org_login}/{c.repo_name}" for c in enabled_thirdparty_sources(db)]
    for cached in browse_thirdparty_skills(source_keys):
        if (cached.get("source"), cached.get("name")) in already_have:
            continue
        skills.append(cached)

    return {"skills": skills}


@router.get("/marketplace-skills/{skill_id}")
def get_marketplace_skill(skill_id: str, current_user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    # Postgres' `id` column is typed UUID — filtering by a non-UUID string
    # (a browse-cache id) raises a DB-level error rather than just returning
    # no match, so a browse id must be recognized and routed to the cache
    # BEFORE ever reaching a Postgres query, not just as a not-found fallback.
    if parse_browse_id(skill_id):
        cached = get_cached_thirdparty_skill(skill_id)
        if cached:
            return cached
        raise HTTPException(status_code=404, detail="Skill not found")

    r = db.query(MarketplaceSkillRecord).filter(MarketplaceSkillRecord.id == skill_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="Skill not found")
    user_id = _current_user_id(current_user)
    installed = db.query(MarketplaceSkillInstallRecord).filter(
        MarketplaceSkillInstallRecord.user_id == user_id,
        MarketplaceSkillInstallRecord.skill_id == skill_id,
    ).first() is not None
    return _row_to_dict(r, installed)


@router.post("/marketplace-skills")
def create_marketplace_skill(body: MarketplaceSkillCreate, current_user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        user_id = _current_user_id(current_user)
        display = current_user.get("name") or current_user.get("email") or user_id
        rec = MarketplaceSkillRecord(
            name=body.name,
            description=body.description,
            category=body.category,
            icon=body.icon,
            tags=body.tags,
            instructions=body.instructions,
            files=body.files,
            version=1,
            installs=0,
            author=display,
            created_by=user_id,
            department=current_user.get("department"),
            third_party=False,
            source="internal",
            security_status="unscanned",
        )
        scan_and_update(rec)   # sets rec.security_status from the actual content, not the "unscanned" placeholder above
        db.add(rec)
        db.commit()
        db.refresh(rec)
        return _row_to_dict(rec, installed=False)
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/marketplace-skills/{skill_id}")
def update_marketplace_skill(skill_id: str, body: MarketplaceSkillUpdate, current_user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        # A browse-cache id (not a real UUID) can never have a Postgres row
        # to update — querying by it would raise a DB-level cast error
        # instead of a clean 404, so short-circuit before that query.
        r = None if parse_browse_id(skill_id) else db.query(MarketplaceSkillRecord).filter(MarketplaceSkillRecord.id == skill_id).first()
        if not r:
            raise HTTPException(status_code=404, detail="Skill not found")
        if not _is_owner_or_admin(r, current_user):
            raise HTTPException(status_code=403, detail="Only the creator or an admin can update this skill")
        r.name = body.name
        r.description = body.description
        r.category = body.category
        r.icon = body.icon
        r.tags = body.tags
        r.instructions = body.instructions
        r.files = body.files
        r.version = (r.version or 1) + 1   # server-side, not client-computed
        scan_and_update(r)   # content changed — re-scan rather than keep a stale verdict
        user_id = _current_user_id(current_user)
        installed = db.query(MarketplaceSkillInstallRecord).filter(
            MarketplaceSkillInstallRecord.user_id == user_id,
            MarketplaceSkillInstallRecord.skill_id == skill_id,
        ).first() is not None
        db.commit()
        db.refresh(r)
        return _row_to_dict(r, installed)
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/marketplace-skills/{skill_id}")
def delete_marketplace_skill(skill_id: str, current_user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        r = None if parse_browse_id(skill_id) else db.query(MarketplaceSkillRecord).filter(MarketplaceSkillRecord.id == skill_id).first()
        if not r:
            raise HTTPException(status_code=404, detail="Skill not found")
        if not _is_owner_or_admin(r, current_user):
            raise HTTPException(status_code=403, detail="Only the creator or an admin can delete this skill")
        db.delete(r)   # cascades marketplace_skill_installs_pg rows via ondelete="CASCADE"
        db.commit()
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/marketplace-skills/upload")
def upload_marketplace_skills(body: MarketplaceSkillUploadRequest, current_user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        user_id = _current_user_id(current_user)
        display = current_user.get("name") or current_user.get("email") or user_id
        created = []
        for entry in body.skills:
            rec = MarketplaceSkillRecord(
                name=entry.name,
                description=entry.description,
                category="",
                icon="",
                tags=[],
                instructions=entry.instructions,
                files=entry.files,
                version=1,
                installs=0,
                author=display,
                created_by=user_id,
                department=current_user.get("department"),
                third_party=False,
                source="internal",
                security_status="unscanned",
            )
            scan_and_update(rec)
            db.add(rec)
            created.append(rec)
        db.commit()
        for rec in created:
            db.refresh(rec)
        return {"skills": [_row_to_dict(r, installed=False) for r in created]}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


def _install_from_browse_cache(browse_id: str, db: Session):
    """A skill that's never been installed by anyone has no Postgres row —
    it only exists as a browse-cache entry (services/marketplace_skill_ingestion.py).
    Installing it is the ONE moment it becomes a real, permanently-stored
    catalog row. Never trusts the cache's own license/security fields for
    that decision: re-fetches and re-classifies live, at the exact commit
    the cache entry was pinned to, via refetch_and_verify_skill(). Returns
    the (possibly newly-created) MarketplaceSkillRecord, or None if this
    isn't a browse id, the source's since been disabled, or re-verification
    failed — caller treats None the same as "not found"."""
    parsed = parse_browse_id(browse_id)
    if not parsed:
        return None
    org_login, repo_name, _folder = parsed
    source_key = f"{org_login}/{repo_name}"

    config = next((c for c in enabled_thirdparty_sources(db) if f"{c.org_login}/{c.repo_name}" == source_key), None)
    if not config:
        return None   # source disabled/removed since this id was shown to the client — refuse, don't trust the cache

    verified = refetch_and_verify_skill(browse_id, config.allowed_licenses)
    if not verified:
        return None

    # Find-or-create by name — the existing partial unique index
    # (uq_marketplace_skills_seed_name, third_party=true rows) is the same
    # DB-level race guard already used for seed data; a second concurrent
    # installer of the same not-yet-permanent skill hits IntegrityError and
    # just uses the row the first one created instead of erroring.
    existing = db.query(MarketplaceSkillRecord).filter(
        MarketplaceSkillRecord.name == verified["name"],
        MarketplaceSkillRecord.third_party.is_(True),
    ).first()
    if existing:
        return existing

    rec = MarketplaceSkillRecord(
        name=verified["name"], description=verified["description"], instructions=verified["instructions"],
        category="", icon="\U0001F916", tags=[], files=[], version=1, installs=0,
        author=verified["author"], created_by=None, department=None, third_party=True,
        source=verified["source"], source_ref=verified["source_ref"], license=verified["license"],
        security_status=verified["securityStatus"],
    )
    db.add(rec)
    try:
        db.flush()   # surface an IntegrityError here, inside this function's control, not the caller's
    except IntegrityError:
        db.rollback()
        return db.query(MarketplaceSkillRecord).filter(
            MarketplaceSkillRecord.name == verified["name"],
            MarketplaceSkillRecord.third_party.is_(True),
        ).first()
    return rec


@router.post("/marketplace-skills/{skill_id}/install")
def install_marketplace_skill(skill_id: str, current_user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        # Same reason as get_marketplace_skill: a browse-cache id is not a
        # valid UUID, so it must never reach the Postgres query below (that
        # raises a DB-level cast error instead of a clean "no row").
        if parse_browse_id(skill_id):
            r = _install_from_browse_cache(skill_id, db)
        else:
            r = db.query(MarketplaceSkillRecord).filter(MarketplaceSkillRecord.id == skill_id).first()
        if not r:
            raise HTTPException(status_code=404, detail="Skill not found")
        # Re-check, not just read the stored value — scanner rules or the
        # skill's own trust classification may have changed since it was
        # last scanned (e.g. right after Phase 3 ingestion, before this
        # endpoint existed, or a scanner rule update since). A skill that
        # just got copied in from the browse cache by _install_from_browse_cache
        # was already re-verified live moments ago — this re-scan is cheap
        # and keeps this endpoint's behavior identical either way, not a
        # second, different check.
        scan_and_update(r)
        if r.security_status == "blocked":
            db.commit()   # persist the (re-)blocked status even though install is refused
            raise HTTPException(status_code=403, detail="This skill has been blocked and cannot be enabled")
        # License compatibility, re-checked at USE time too, not just at
        # ingestion — defense in depth: catches a record whose license was
        # somehow set incorrectly, or a future source-config narrowing after
        # the skill was already ingested. Only applies to GENUINELY
        # externally-sourced content (source != "internal"), not just
        # third_party=True — the 6 demo seed skills (seed_marketplace_skills)
        # are flagged third_party=True purely so the UI's legal-check-modal
        # flow has something to demo, but source="internal" (AiNxt-authored,
        # no real upstream license to be MIT-incompatible with in the first
        # place). Gating on third_party alone made those permanently
        # uninstallable the moment license-compatibility became a real
        # check — caught by testing, not by a user report.
        if r.third_party and r.source != "internal" and not is_mit_compatible_license(r.license):
            raise HTTPException(
                status_code=403,
                detail=f"This skill's license ({r.license or 'none on file'}) is not compatible with this "
                       f"project's MIT license and cannot be enabled.",
            )
        # r.id, not the path param `skill_id`: when `r` was just created by
        # _install_from_browse_cache, `skill_id` is still the synthetic
        # browse id (base64url-encoded, see _browse_id()'s docstring for why) — the install
        # row's FK must point at the real Postgres row's real UUID.
        user_id = _current_user_id(current_user)
        existing = db.query(MarketplaceSkillInstallRecord).filter(
            MarketplaceSkillInstallRecord.user_id == user_id,
            MarketplaceSkillInstallRecord.skill_id == r.id,
        ).first()
        if not existing:
            db.add(MarketplaceSkillInstallRecord(user_id=user_id, skill_id=r.id))
            r.installs = (r.installs or 0) + 1
        db.commit()
        return {"installed": True, "installs": r.installs, "securityStatus": r.security_status, "id": r.id}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/marketplace-skills/{skill_id}/install")
def uninstall_marketplace_skill(skill_id: str, current_user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        # A never-installed browse-cache skill has nothing to uninstall.
        r = None if parse_browse_id(skill_id) else db.query(MarketplaceSkillRecord).filter(MarketplaceSkillRecord.id == skill_id).first()
        if not r:
            raise HTTPException(status_code=404, detail="Skill not found")
        user_id = _current_user_id(current_user)
        existing = db.query(MarketplaceSkillInstallRecord).filter(
            MarketplaceSkillInstallRecord.user_id == user_id,
            MarketplaceSkillInstallRecord.skill_id == skill_id,
        ).first()
        if existing:
            db.delete(existing)
            r.installs = max(0, (r.installs or 0) - 1)
        db.commit()
        return {"installed": False, "installs": r.installs}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# ADMIN — Layer-2 source config for external ingestion (Phase 3).
# Small surface on purpose: this table is not "manage every marketplace
# integration setting" — it's just enough to see status and flip the one
# runtime-adjustable kill switch admins actually need day to day. Adding a
# brand-new source row (not just toggling an existing one) is deliberately
# not exposed here — per marketplace_skills_plan.md §3.4, a new source needs
# its own env flag (core/config.py) and ingestion routine (services/
# marketplace_skill_ingestion.py) added first, so there is nothing for an
# admin to safely self-service into existence via this API alone.
# ============================================================

def _source_config_to_dict(c: MarketplaceSourceConfigRecord) -> dict:
    return {
        "id": c.id,
        "orgLogin": c.org_login,
        "repoName": c.repo_name,
        "enabled": c.enabled,
        "allowedLicenses": c.allowed_licenses or [],
        "syncIntervalMinutes": c.sync_interval_minutes,
        "anomalyThresholdPct": c.anomaly_threshold_pct,
        "lastSyncedAt": int(c.last_synced_at.timestamp() * 1000) if c.last_synced_at else None,
        "lastSyncStatus": c.last_sync_status,
    }


class MarketplaceSourceConfigUpdate(BaseModel):
    enabled: Optional[bool] = None
    allowed_licenses: Optional[List[str]] = None
    sync_interval_minutes: Optional[int] = None
    anomaly_threshold_pct: Optional[int] = None


@router.get("/marketplace-source-configs")
def list_marketplace_source_configs(current_user: dict = Depends(require_admin), db: Session = Depends(get_db)):
    rows = db.query(MarketplaceSourceConfigRecord).order_by(MarketplaceSourceConfigRecord.org_login.asc()).all()
    return {"sources": [_source_config_to_dict(r) for r in rows]}


@router.patch("/marketplace-source-configs/{config_id}")
def update_marketplace_source_config(config_id: str, body: MarketplaceSourceConfigUpdate,
                                      current_user: dict = Depends(require_admin), db: Session = Depends(get_db)):
    try:
        r = db.query(MarketplaceSourceConfigRecord).filter(MarketplaceSourceConfigRecord.id == config_id).first()
        if not r:
            raise HTTPException(status_code=404, detail="Source config not found")
        if body.enabled is not None:
            r.enabled = body.enabled
        if body.allowed_licenses is not None:
            # An admin can narrow or reorder the allowlist, but never widen it
            # to a license this codebase doesn't actually know how to judge
            # as MIT-compatible — that determination lives in
            # services/marketplace_skill_ingestion.py's MIT_COMPATIBLE_LICENSES,
            # not in admin-supplied free text.
            unknown = [lic for lic in body.allowed_licenses if lic not in MIT_COMPATIBLE_LICENSES]
            if unknown:
                raise HTTPException(status_code=422, detail=f"Not a recognized MIT-compatible license: {unknown}")
            r.allowed_licenses = body.allowed_licenses
        if body.sync_interval_minutes is not None:
            r.sync_interval_minutes = body.sync_interval_minutes
        if body.anomaly_threshold_pct is not None:
            r.anomaly_threshold_pct = body.anomaly_threshold_pct
        db.commit()
        db.refresh(r)
        return _source_config_to_dict(r)
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# SEED DATA — moved server-side from ai-ui/src/marketplaceStore.js's
# refreshSeedData(). Same stable ids, so a plugin seed elsewhere that
# references "seed-skill-bug-triager" by id keeps resolving correctly.
# ============================================================

_SEED_SKILLS = [
    {
        "name": "Meeting Notes Summarizer", "category": "Productivity",
        "icon": "\U0001F4DD", "author": "BrightOps", "days_ago": 2, "installs": 18,
        "description": "Turns a raw meeting transcript into a structured summary with decisions and action items.",
        "tags": ["meetings", "summarization"],
        "instructions": "Given a meeting transcript, extract: 1) key decisions, 2) action items with an owner and due date, 3) open questions. Keep the summary under 200 words and use bullet points.",
    },
    {
        "name": "SQL Query Explainer", "category": "Data & Analytics",
        "icon": "\U0001F4CA", "author": "QueryLens", "days_ago": 5, "installs": 11,
        "description": "Explains what a SQL query does in plain English, and flags likely performance issues.",
        "tags": ["sql", "data"],
        "instructions": "Given a SQL query, explain step by step what it returns, note any missing indexes or full-table scans, and suggest one concrete optimization if applicable.",
    },
    {
        "name": "Contract Clause Reviewer", "category": "Legal",
        "icon": "\U0001F6E1️", "author": "ClauseGuard", "days_ago": 9, "installs": 6,
        "description": "Flags unusual or risky clauses in a contract draft against common enterprise norms.",
        "tags": ["contracts", "risk"],
        "instructions": "Given a contract clause, identify whether it deviates from standard enterprise terms (liability caps, termination notice, indemnity), and explain the risk in one sentence.",
    },
    {
        "name": "Bug Report Triager", "category": "Engineering",
        "icon": "\U0001F9EA", "author": "BrightOps", "days_ago": 1, "installs": 3,
        "description": "Classifies an incoming bug report by severity and suggests the likely owning team.",
        "tags": ["engineering", "triage"],
        "instructions": "Given a bug report, output: severity (P1-P4), likely affected component, and a one-line reproduction summary.",
    },
    {
        "name": "Invoice Data Extractor", "category": "Finance",
        "icon": "\U0001F9E0", "author": "LedgerFlow", "days_ago": 6, "installs": 9,
        "description": "Pulls vendor, line items, and totals out of an invoice PDF or image into structured fields.",
        "tags": ["finance", "invoices"],
        "instructions": "Given invoice text or OCR output, extract vendor name, invoice number, line items (description, quantity, unit price), and the total due. Flag if the total doesn't match the sum of line items.",
    },
    {
        "name": "Customer Sentiment Analyzer", "category": "Support",
        "icon": "\U0001F4A1", "author": "PulseMetrics", "days_ago": 3, "installs": 14,
        "description": "Scores a support ticket or review for sentiment and urgency, and suggests a response tone.",
        "tags": ["support", "sentiment"],
        "instructions": "Given customer text, output: sentiment (positive/neutral/negative), urgency (low/medium/high), and one sentence suggesting the tone of the reply.",
    },
]


def seed_marketplace_skills():
    """
    Idempotent seed: insert the fake third-party demo skills if they don't
    exist yet, matched by name (this table's `id` is a real Postgres UUID
    column — same convention as db.models.SkillRecord — so, unlike the old
    localStorage version, seed rows can't use human-readable string ids).
    Called once at gateway startup — but gunicorn boots multiple worker
    processes, each running the FastAPI startup event independently, so a
    plain "SELECT then INSERT if missing" check has a TOCTOU race between
    workers. The `uq_marketplace_skills_seed_name` partial unique index
    (db/models.py) closes that at the DB level; each row is committed
    individually here so a losing worker's IntegrityError on one row
    doesn't abort the rest of its own seed pass.
    """
    db = SessionLocal()
    try:
        for s in _SEED_SKILLS:
            existing = db.query(MarketplaceSkillRecord).filter(
                MarketplaceSkillRecord.name == s["name"],
                MarketplaceSkillRecord.third_party.is_(True),
            ).first()
            if existing:
                continue   # already seeded — skip, keep installs/created_at organic
            rec = MarketplaceSkillRecord(
                name=s["name"],
                description=s["description"],
                category=s["category"],
                icon=s["icon"],
                tags=s["tags"],
                instructions=s["instructions"],
                files=[],
                version=1,
                installs=s["installs"],
                author=s["author"],
                created_by=None,
                department=None,
                third_party=True,
                source="internal",
                security_status="unscanned",
                created_at=datetime.utcnow() - timedelta(days=s["days_ago"]),
            )
            scan_and_update(rec)   # curated demo content — expected to resolve to "passed", but run the real scan rather than assume it
            db.add(rec)
            try:
                db.commit()
                logger.info(f"Seeded marketplace skill: {s['name']}")
            except IntegrityError:
                # Another worker won the race and already inserted this
                # name — not an error, just nothing left to do here.
                db.rollback()
    except Exception as exc:
        db.rollback()
        logger.warning(f"seed_marketplace_skills: {exc}")
    finally:
        db.close()
