# SPDX-License-Identifier: MIT
# ============================================================
# MARKETPLACE SKILLS — STATIC SECURITY SCANNER (Phase 4 of marketplace_skills_plan.md)
#
# Our Skills are plain SKILL.md-style instructions + optional non-executable
# supporting files — no code-execution path exists for a skill in this
# system (unlike Hermes-agent's CLI-agent, which can run skills as shell/
# tool actions; see plan §4.2). This scanner exists because a "skill" is
# still text prepended to a system prompt, and can attempt prompt injection,
# instruct the model to exfiltrate data via tool calls it does have access
# to, or otherwise try to manipulate behavior. The category/severity shape
# mirrors Hermes-agent's own tools/skills_guard.py in spirit (independently
# reimplemented here, not copied — Hermes is MIT-licensed so this is just a
# credited design reference).
#
# No cryptographic signature verification — same as Hermes: trust comes
# from Phase 3's trust anchoring (pinned commits, verified org, reviewed
# license) plus this content scan, not code signing.
# ============================================================

import re
from typing import List, Optional

from core.logger import logger

# (compiled pattern, category, severity) — severity: "dangerous" | "caution".
# One match is enough to record that category; scanning stops recording
# duplicates of the same category but keeps checking the rest.
_PATTERNS = [
    # ── Exfiltration ──
    # NOTE: deliberately NOT matching a bare "token" here — real-world
    # testing against anthropics/skills' own `claude-api` skill produced a
    # false positive: "POST /v1/files ... Token Counting" matched
    # send/post + token even though it's just API documentation, not a
    # credential-exfiltration attempt. "token" alone is too overloaded in
    # LLM/API docs (token counting, max_tokens, token limit, ...) to be a
    # reliable signal; requiring a more specific "<kind> token" phrase (auth/
    # access/bearer/refresh/session/API token) fixes this without losing the
    # actual credential-exfiltration case.
    (re.compile(r"\b(send|post|upload|exfiltrate|transmit)\b.{0,25}\b(api[\s_-]?key|password|secret|credential|private[\s_-]?key|"
                r"(?:auth|access|bearer|refresh|session|api)[\s_-]?token)", re.I),
     "exfiltration", "dangerous"),
    (re.compile(r"\b(curl|wget|fetch|requests\.(get|post))\b.{0,60}\b(webhook\.site|ngrok\.io|pastebin\.com|requestbin)", re.I),
     "exfiltration", "dangerous"),
    (re.compile(r"\b(email|send)\b.{0,40}\b(all|every)\b.{0,20}\b(file|document|conversation|message)s?\b.{0,40}\bto\b", re.I),
     "exfiltration", "dangerous"),

    # ── Prompt injection ──
    (re.compile(r"\bignore (all |any )?(previous|prior|above|earlier) instructions\b", re.I),
     "prompt_injection", "caution"),
    (re.compile(r"\byou are now\b.{0,30}\b(unrestricted|jailbroken|dan|do anything now)\b", re.I),
     "prompt_injection", "dangerous"),
    (re.compile(r"\breveal\b.{0,30}\b(system prompt|hidden instructions|internal instructions)\b", re.I),
     "prompt_injection", "dangerous"),

    # ── Destructive ──
    (re.compile(r"\brm\s+-rf\s+[/~]", re.I), "destructive", "dangerous"),
    (re.compile(r"\b(drop|truncate)\s+(table|database|schema)\b", re.I), "destructive", "dangerous"),
    (re.compile(r"\bformat\s+[a-z]:\b", re.I), "destructive", "dangerous"),

    # ── Obfuscation / persistence ──
    (re.compile(r"\bbase64\s*(decode|-d)\b.{0,40}\b(exec|eval|run|system)\b", re.I),
     "obfuscated_payload", "dangerous"),
    (re.compile(r"\b(crontab|systemd|registry run key|startup folder)\b.{0,40}\b(add|install|persist)\b", re.I),
     "persistence", "caution"),

    # ── Hardcoded secrets (the exact thing Anthropic's own "creating custom
    # skills" doc explicitly warns skill authors against — see the Claude
    # Desktop reference section of the plan) ──
    (re.compile(r"\b(api[\s_-]?key|secret[\s_-]?key|password)\s*[:=]\s*['\"][A-Za-z0-9/_+=-]{12,}['\"]", re.I),
     "hardcoded_secret", "caution"),
]


def scan_skill_content(instructions: Optional[str], files: Optional[list] = None) -> dict:
    """Returns {"verdict": "passed"|"caution"|"blocked", "findings": [{"category","severity","excerpt"}]}."""
    text_blobs = [instructions or ""]
    for f in (files or []):
        content = (f or {}).get("content")
        if isinstance(content, str):
            text_blobs.append(content)

    findings = []
    seen_categories = set()
    for pattern, category, severity in _PATTERNS:
        if category in seen_categories:
            continue
        for blob in text_blobs:
            m = pattern.search(blob)
            if m:
                findings.append({
                    "category": category,
                    "severity": severity,
                    "excerpt": blob[max(0, m.start() - 20):m.end() + 20],
                })
                seen_categories.add(category)
                break

    if any(f["severity"] == "dangerous" for f in findings):
        verdict = "blocked"
    elif findings:
        verdict = "caution"
    else:
        verdict = "passed"
    return {"verdict": verdict, "findings": findings}


# Trust-tiered install policy (plan §4.2), matching Hermes-agent's own
# INSTALL_POLICY in spirit — Hermes's version of this set has four entries
# ({"openai/skills", "anthropics/skills", "huggingface/skills", "NVIDIA/skills"});
# ours starts with one on purpose, not as a limitation of the mechanism.
# This set is generic (any "org/repo" string works, same as
# services/marketplace_skill_ingestion.py's _INGESTORS mapping) — adding a
# second entry once a source clears independent verification (plan §3.3:
# confirmed org id, confirmed license structure) is a one-line change here,
# not new code:
#   internal (self-authored)         -> only "blocked" (dangerous) blocks
#   trusted source (verified, §3.3)  -> only "blocked" (dangerous) blocks
#   any other third-party source     -> "caution" OR "blocked" both block
# A "blocked" verdict is always a hard stop — no tier ever overrides it.
TRUSTED_SOURCES = {"anthropics/skills"}


def resolve_security_status(third_party: bool, source: Optional[str], instructions: Optional[str],
                             files: Optional[list] = None) -> str:
    """Runs the scan and maps {verdict + trust tier} to the security_status
    value stored on MarketplaceSkillRecord: passed | caution | blocked."""
    result = scan_skill_content(instructions, files)
    verdict = result["verdict"]

    if verdict == "blocked":
        return "blocked"  # hard stop, every tier, no override

    if not third_party or (source in TRUSTED_SOURCES):
        # Internal (creator accountable via created_by) or a verified
        # trusted source — "caution" installs with a warning, doesn't block.
        return verdict  # "caution" or "passed"

    # Any other third-party/community source — caution also blocks.
    return "blocked" if verdict == "caution" else "passed"


def scan_and_update(record) -> str:
    """Convenience wrapper: scan `record` (a MarketplaceSkillRecord-like
    object with .third_party/.source/.instructions/.files) and set its
    .security_status in place. Returns the resolved status. Caller is
    responsible for committing the session."""
    status = resolve_security_status(record.third_party, record.source, record.instructions, record.files)
    record.security_status = status
    if status != "passed":
        logger.info(f"[skill-security-scan] '{record.name}' (source={record.source}) -> {status}")
    return status
