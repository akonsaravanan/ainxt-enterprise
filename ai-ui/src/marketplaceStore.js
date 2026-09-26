// SPDX-License-Identifier: MIT
// Marketplace local data store.
//
// This Marketplace is a fresh, standalone feature: it does not read from or
// write to any pre-existing skill/connector/plugin system in this codebase
// (not the in-memory mcp_registry, not the SkillRecord governance table, not
// connector_definitions, not curated_plugins.json, not anything Agent Studio
// uses). None of those are touched by this file or by Marketplace.jsx.
//
// Skills are now backed by a real API (see skillsApi below) — routers/
// marketplace_skills_router.py + db.models.MarketplaceSkillRecord. Connectors
// and Plugins are still UI-first: everything created through those two tabs
// is persisted to localStorage in the shape a future API would return, via
// the same list/get/create/update/remove contract skillsApi already uses for
// real, so swapping their bodies for HTTP calls later shouldn't require
// touching any caller in Marketplace.jsx.

import { API_BASE as API, authFetch } from "./config.js";

const KEYS = {
  skills: "ainxt.marketplace2.skills",
  connectors: "ainxt.marketplace2.connectors",
  plugins: "ainxt.marketplace2.plugins",
  installed: "ainxt.marketplace2.installed",
};

function read(key) {
  try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full/unavailable — ignore */ }
}
function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const SKILL_CATEGORIES = [
  "Engineering", "Sales", "Marketing", "Legal", "Finance",
  "HR", "Support", "Productivity", "Data & Analytics", "Design", "Other",
];
export const CONNECTOR_CATEGORIES = ["Productivity", "Communication", "Developer Tools", "CRM", "Data", "Other"];

// Mirrors services/marketplace_skill_ingestion.py's MIT_COMPATIBLE_LICENSES
// keys — display-only (the backend is the actual enforcement point, both at
// ingestion and again at install time); used here just to distinguish "no
// license on file" from "a license is on file but it isn't one we recognize
// as MIT-compatible" in the UI, since those are different, honest messages.
export const MIT_COMPATIBLE_LICENSE_IDS = ["MIT", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "ISC"];

// A third-party skill is usable only with a license we can positively verify
// as MIT-compatible — missing and incompatible are both "no", not just
// incompatible. Internal (non-third-party) skills have no upstream license
// to be compatible with, so this only ever applies when item.thirdParty —
// AND only when it's genuinely externally-sourced (source !== "internal").
// The 6 demo seed skills are flagged thirdParty=true purely so the
// legal-check-modal flow has something to demo, but source="internal"
// (AiNxt-authored, no real upstream license) — gating on thirdParty alone
// made them permanently uninstallable once this check went live, which is
// the wrong call for AiNxt's own demo content.
export function isSkillLicenseUsable(item) {
  return !item.thirdParty || item.source === "internal"
    || (!!item.license && MIT_COMPATIBLE_LICENSE_IDS.includes(item.license));
}

// ── SKILL.md format ────────────────────────────────────────────────────────
// Modelled on the same shape Claude's own Agent Skills use: a YAML
// frontmatter block (---...---) with required `name` and `description`
// fields, followed by a markdown body that becomes the skill's instructions.
// This is enforced client-side only for now — see the note at the top of
// this file about the UI-first phase.
export const SKILL_MD_EXAMPLE = `---
name: my-skill-name
description: One or two sentences on what this skill does and when to use it.
---

# Instructions

Explain step by step what the model should do when this skill is used.
Be specific about expected inputs and the shape of the output.
`;

/**
 * Parse a SKILL.md file's text content.
 * Returns { valid: true, name, description, instructions } on success, or
 * { valid: false, errors: string[] } listing every problem found — the
 * caller shows these directly in the UI rather than a generic failure.
 */
export function parseSkillMarkdown(raw) {
  const errors = [];
  const text = String(raw || "");

  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    return {
      valid: false,
      errors: [
        "The file must start with a YAML frontmatter block delimited by --- lines, e.g.:",
        "---\nname: my-skill-name\ndescription: ...\n---",
      ],
    };
  }
  const [, frontmatterRaw, body] = fmMatch;

  const fm = {};
  frontmatterRaw.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (m) fm[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  });

  // Plain human-readable names ("Weekly status report") are valid — Claude's
  // own skill names aren't slugs, so this only rejects an empty value.
  if (!fm.name) errors.push('Missing required frontmatter field: "name".');
  else if (fm.name.length > 64) errors.push(`"name" must be 64 characters or fewer (this is ${fm.name.length}) — matches the real SKILL.md spec.`);
  if (!fm.description) errors.push('Missing required frontmatter field: "description".');
  else if (fm.description.length > 200) errors.push(`"description" must be 200 characters or fewer (this is ${fm.description.length}) — matches the real SKILL.md spec.`);
  if (!body || !body.trim()) errors.push("No instructions found in the file body (the markdown content below the closing --- ).");

  if (errors.length) return { valid: false, errors };
  return { valid: true, name: fm.name, description: fm.description, instructions: body.trim() };
}

/** The inverse of parseSkillMarkdown — reconstructs a canonical SKILL.md
 * from a stored skill object, for the Contents tab's preview/raw view and
 * its download button. */
export function buildSkillMarkdown(skill) {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.instructions || ""}\n`;
}

export const SKILL_ICONS = ["🧠", "📝", "🔍", "📊", "🛡️", "🧪", "🗂️", "📚", "💡", "🚀"];
export const CONNECTOR_ICONS = ["🔗", "📧", "💬", "📁", "🗓️", "🏢", "🐙", "🎫", "☁️", "🔐"];
export const PLUGIN_ICONS = ["🧩", "📦", "⚙️", "🛠️", "🎁", "🧰", "🪄", "🔧", "📇", "🗃️"];

function makeCrud(key, defaults) {
  return {
    list: () => read(key),
    get: (id) => read(key).find((x) => x.id === id) || null,
    create: (data) => {
      const items = read(key);
      const item = {
        id: uid(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        installs: 0,
        version: 1,
        author: "You",
        ...defaults,
        ...data,
      };
      items.unshift(item);
      write(key, items);
      return item;
    },
    update: (id, patch) => {
      const items = read(key).map((x) => (x.id === id ? { ...x, ...patch, updatedAt: Date.now() } : x));
      write(key, items);
      return items.find((x) => x.id === id) || null;
    },
    remove: (id) => {
      write(key, read(key).filter((x) => x.id !== id));
      const installed = readInstalled();
      installed.delete(`skill:${id}`); installed.delete(`connector:${id}`); installed.delete(`plugin:${id}`);
      writeInstalled(installed);
    },
  };
}

export const connectorsStore = makeCrud(KEYS.connectors, { tags: [], authType: "api_key", baseUrl: "" });
export const pluginsStore = makeCrud(KEYS.plugins, { tags: [], skillIds: [], connectorIds: [] });

// ── Skills: real backend (routers/marketplace_skills_router.py) ───────────
// Async, unlike connectorsStore/pluginsStore above — every call can fail
// (network/auth/validation/the Phase 4 security gate), so every function
// here throws on a non-ok response and the caller (Marketplace.jsx) is
// expected to catch and toast.error(...), a path that plain localStorage
// never needed.
async function _errMessage(res, fallback) {
  try {
    const data = await res.json();
    if (typeof data.detail === "string") return data.detail;
    // FastAPI's own 422 validation errors return `detail` as an array of
    // {msg, loc, ...} objects, not a string — stringify those sensibly
    // rather than letting a toast render "[object Object]".
    if (Array.isArray(data.detail)) {
      const msg = data.detail.map((d) => d?.msg || JSON.stringify(d)).join("; ");
      return msg || fallback;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export const skillsApi = {
  async list() {
    const res = await authFetch(`${API}/marketplace-skills`);
    if (!res.ok) throw new Error(await _errMessage(res, "Failed to load skills."));
    const data = await res.json();
    return data.skills || [];
  },
  async get(id) {
    const res = await authFetch(`${API}/marketplace-skills/${id}`);
    if (!res.ok) throw new Error(await _errMessage(res, "Failed to load skill."));
    return res.json();
  },
  async create(data) {
    const res = await authFetch(`${API}/marketplace-skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(await _errMessage(res, "Failed to create skill."));
    return res.json();
  },
  async update(id, data) {
    const res = await authFetch(`${API}/marketplace-skills/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(await _errMessage(res, "Failed to update skill."));
    return res.json();
  },
  async remove(id) {
    const res = await authFetch(`${API}/marketplace-skills/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await _errMessage(res, "Failed to delete skill."));
    return res.json();
  },
  async upload(entries) {
    const res = await authFetch(`${API}/marketplace-skills/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skills: entries }),
    });
    if (!res.ok) throw new Error(await _errMessage(res, "Failed to upload skills."));
    const data = await res.json();
    return data.skills || [];
  },
  async install(id) {
    const res = await authFetch(`${API}/marketplace-skills/${id}/install`, { method: "POST" });
    if (!res.ok) throw new Error(await _errMessage(res, "Failed to enable this skill for chat."));
    return res.json();
  },
  async uninstall(id) {
    const res = await authFetch(`${API}/marketplace-skills/${id}/install`, { method: "DELETE" });
    if (!res.ok) throw new Error(await _errMessage(res, "Failed to remove this skill from chat."));
    return res.json();
  },
};

const STORE_BY_KIND = { connector: connectorsStore, plugin: pluginsStore };
export function storeFor(kind) { return STORE_BY_KIND[kind]; }

function readInstalled() {
  try { return new Set(JSON.parse(localStorage.getItem(KEYS.installed) || "[]")); } catch { return new Set(); }
}
function writeInstalled(set) { write(KEYS.installed, [...set]); }

export function isInstalled(kind, id) { return readInstalled().has(`${kind}:${id}`); }

export function toggleInstalled(kind, id) {
  const set = readInstalled();
  const key = `${kind}:${id}`;
  const store = STORE_BY_KIND[kind];
  const item = store.get(id);
  if (!item) return false;
  if (set.has(key)) {
    set.delete(key);
    store.update(id, { installs: Math.max(0, (item.installs || 0) - 1) });
  } else {
    set.add(key);
    store.update(id, { installs: (item.installs || 0) + 1 });
  }
  writeInstalled(set);
  return set.has(key);
}

// ---- Seed data, refreshed on every load ----
// Clearly first-party example content — distinguishable from anything a real
// user creates. Uses STABLE ids and upserts on every module load rather than
// a one-time flag: this feature is still being actively designed, so seed
// *content* changes from one code update to the next need to actually reach
// a browser that already visited the app once — a one-time flag would freeze
// that browser on whatever seed shape existed the first time it loaded.
// Real user-created items always get random ids (see makeCrud/uid above), so
// they never collide with these and are never touched by this refresh.
//
// Skills seeding moved server-side (see routers/marketplace_skills_router.py
// seed_marketplace_skills(), same stable ids) now that Skills has a real
// backend — only Connectors/Plugins are still seeded here, since those tabs
// stay on localStorage for now.
function upsertSeed(store, id, data) {
  const existing = store.get(id);
  if (existing) {
    // Keep installs/createdAt "organic" across refreshes; refresh everything
    // else so content edits in this file actually show up.
    return store.update(id, { ...data, installs: existing.installs, createdAt: existing.createdAt });
  }
  return store.create({ id, ...data });
}

function refreshSeedData() {
  const daysAgo = (n) => Date.now() - n * 86400000;
  const team = "AiNxt Team";

  upsertSeed(connectorsStore, "seed-connector-wiki", {
    name: "Internal Wiki", category: "Productivity", icon: "📁", author: team, createdAt: daysAgo(4),
    description: "Search and read pages from your team's internal wiki.",
    tags: ["docs"], authType: "api_key", baseUrl: "https://wiki.internal.example.com/api",
    installs: 9,
  });
  const ticketing = upsertSeed(connectorsStore, "seed-connector-ticketing", {
    name: "Ticketing System", category: "Developer Tools", icon: "🎫", author: team, createdAt: daysAgo(7),
    description: "Look up and comment on tickets in your team's issue tracker.",
    tags: ["tickets"], authType: "oauth2", baseUrl: "https://tickets.internal.example.com",
    installs: 14,
  });
  upsertSeed(connectorsStore, "seed-connector-calendar", {
    name: "Team Calendar", category: "Productivity", icon: "🗓️", author: team, createdAt: daysAgo(3),
    description: "Check availability and upcoming meetings for the team.",
    tags: ["calendar"], authType: "oauth2", baseUrl: "https://calendar.internal.example.com",
    installs: 5,
  });

  upsertSeed(pluginsStore, "seed-plugin-engineering-bundle", {
    name: "Engineering Bundle", category: "Engineering", icon: "🧰", author: team, createdAt: daysAgo(1),
    description: "Everything for daily engineering work: bug triage plus your ticketing system, in one install.",
    // No skillIds here on purpose: Skills now live server-side with real
    // (Postgres UUID) ids that aren't known at module-load time, unlike the
    // old localStorage version's stable "seed-skill-*" string ids. Plugins
    // stays localStorage-only for now (separate future backend phase), so
    // this bundle just links the connector; a real skill link can be added
    // once Plugins gets wired to the same real API as Skills.
    tags: ["engineering"], skillIds: [], connectorIds: [ticketing.id],
    installs: 7,
  });
}
refreshSeedData();
