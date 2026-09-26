// SPDX-License-Identifier: MIT
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import JSZip from "jszip";
import { useToast, useConfirm } from "./ui/DialogProvider.jsx";
import {
  Search, ChevronDown, ChevronLeft, Check, Plus, ArrowUpDown, X, Trash2, Pencil,
  Upload, FileText, Sparkles, AlertCircle, CheckCircle2,
  MoreVertical, User, Plug, Info, Download, Eye, Code2, Loader2,
} from "lucide-react";
import {
  skillsApi, connectorsStore, pluginsStore,
  isInstalled, toggleInstalled, parseSkillMarkdown, buildSkillMarkdown, SKILL_MD_EXAMPLE,
  SKILL_CATEGORIES, CONNECTOR_CATEGORIES, SKILL_ICONS, CONNECTOR_ICONS, PLUGIN_ICONS,
  MIT_COMPATIBLE_LICENSE_IDS, isSkillLicenseUsable,
} from "../marketplaceStore.js";

// Marketplace — a fresh, standalone feature modelled on Claude's Customize
// page (Skills / Connectors / Plugins tabs; a "For You" / "New" / "Most
// installed" / "Categories" browse layout; a full detail page per item; a
// proper creation form per type), rendered in this app's own light/indigo
// theme. It intentionally does not read from or touch any pre-existing
// skill/connector/plugin system in this codebase — see marketplaceStore.js
// for why, and for the localStorage-backed data layer standing in for a
// real backend until one is built.

const TABS = [
  { key: "skills",     label: "Skills",     store: null,            categories: SKILL_CATEGORIES,     icons: SKILL_ICONS,     accent: "indigo" },
  { key: "connectors", label: "Connectors", store: connectorsStore, categories: CONNECTOR_CATEGORIES, icons: CONNECTOR_ICONS, accent: "sky" },
  { key: "plugins",    label: "Plugins",    store: pluginsStore,    categories: SKILL_CATEGORIES,     icons: PLUGIN_ICONS,    accent: "violet" },
];
const singular = { skills: "skill", connectors: "connector", plugins: "plugin" };

const ACCENT_CHIP = { indigo: "brand-grad-vivid", sky: "bg-sky-500", violet: "bg-violet-500" };
const ACCENT_TEXT = { indigo: "text-indigo-700", sky: "text-sky-700", violet: "text-violet-700" };
const ACCENT_BORDER_HOVER = { indigo: "hover:border-indigo-200", sky: "hover:border-sky-200", violet: "hover:border-violet-200" };

function timeAgo(ts) {
  // Not-yet-installed third-party skills are browse-cache-only and carry no
  // real createdAt/updatedAt (nothing has been persisted for them yet — see
  // services/marketplace_skill_ingestion.py's "browse vs. store" design).
  if (!ts) return "recently";
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months !== 1 ? "s" : ""} ago`;
}

const AINXT_SKILL_DRAFT_PROMPT =
  "Let's create a skill together using your skill-creator skill. First ask me what the skill should do.";

export default function Marketplace({ user }) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const navigate = useNavigate();
  const myIdentity = user?.name || user?.email || "You";

  const createSkillWithAiNxt = () => {
    window.dispatchEvent(new CustomEvent("ainxt:chat-draft", { detail: AINXT_SKILL_DRAFT_PROMPT }));
    navigate("/chat");
  };

  const [activeTab, setActiveTab] = useState("skills");
  const [scope, setScope] = useState("discover"); // "yours" | "discover"
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false);
  const [sortDesc, setSortDesc] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [skillForm, setSkillForm] = useState(null); // { existing } | null — full-page manual Skill form
  const [skillUploadOpen, setSkillUploadOpen] = useState(false); // full-page batch SKILL.md upload
  const [detail, setDetail] = useState(null); // { kind, id }
  const [legalCheck, setLegalCheck] = useState(null); // { tabKey, item } — third-party "use" confirmation
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  // Item ids with an install/uninstall/accept request currently in flight —
  // guards double-submission from an impatient double-click (no loading
  // state before this meant nothing visually stopped a second click from
  // firing a second request while the first was still pending).
  const [busyIds, setBusyIds] = useState(() => new Set());
  const isBusy = (id) => busyIds.has(id);
  const setItemBusy = (id, busy) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id); else next.delete(id);
      return next;
    });
  };

  // ── Skills: real backend, loaded async (Connectors/Plugins stay on the
  // synchronous localStorage stores below, per Phase 1's scope). ──────────
  const [skillsItems, setSkillsItems] = useState([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState(null);

  const loadSkills = useCallback(async () => {
    try {
      const list = await skillsApi.list();
      setSkillsItems(list);
      setSkillsError(null);
    } catch (e) {
      setSkillsError(e.message || "Failed to load skills.");
    } finally {
      setSkillsLoading(false);
    }
  }, []);

  useEffect(() => { loadSkills(); }, [loadSkills]);

  const tab = TABS.find((t) => t.key === activeTab);
  const kind = singular[activeTab];

  // Skills come from the async state above; Connectors/Plugins are still
  // re-read on every `version` bump from synchronous localStorage.
  const items = useMemo(
    () => (activeTab === "skills" ? skillsItems : tab.store.list()),
    [tab, activeTab, version, skillsItems]
  );

  const isMine = (item) => item.author === myIdentity;
  const installedFlag = (item) => (activeTab === "skills" ? !!item.installed : isInstalled(kind, item.id));

  const scoped = useMemo(
    () => (scope === "discover" ? items : items.filter((i) => isMine(i) || installedFlag(i))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, scope, version]
  );

  const categories = useMemo(() => {
    const counts = new Map();
    scoped.forEach((i) => counts.set(i.category, (counts.get(i.category) || 0) + 1));
    return tab.categories.map((c) => ({ name: c, count: counts.get(c) || 0 })).filter((c) => c.count > 0);
  }, [scoped, tab]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let arr = scoped.filter((i) => {
      if (category !== "all" && i.category !== category) return false;
      if (!q) return true;
      return i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || (i.tags || []).some((t) => t.toLowerCase().includes(q));
    });
    arr = [...arr].sort((a, b) => a.name.localeCompare(b.name));
    return sortDesc ? arr.reverse() : arr;
  }, [scoped, search, category, sortDesc]);

  const isBrowsing = scope === "discover" && !search.trim() && category === "all";

  const openDetail = (id) => setDetail({ kind: activeTab, id });

  // The one gate in this whole feature: a third-party skill you haven't
  // already added goes through a confirmation step first ("Legal &
  // compatibility check" — UI-only for now, see ThirdPartyCheckModal).
  // Everything else (your own skills, connectors, plugins, removing
  // anything) toggles immediately, same as before.
  const requestUse = async (tabKey, item) => {
    if (tabKey === "skills") {
      if (isBusy(item.id)) return;   // request already in flight for this item — ignore the extra click
      const already = !!item.installed;
      if (!already && item.thirdParty) {
        setLegalCheck({ tabKey, item });
        return;
      }
      setItemBusy(item.id, true);
      try {
        if (already) await skillsApi.uninstall(item.id);
        else await skillsApi.install(item.id);
        await loadSkills();
      } catch (e) {
        toast.error(e.message || "Couldn't update this skill's chat availability.");
      } finally {
        setItemBusy(item.id, false);
      }
      return;
    }
    const k = singular[tabKey];
    toggleInstalled(k, item.id);
    bump();
  };
  // Shared by both places ThirdPartyCheckModal can render (the browse-grid
  // return AND the skill-detail-page return — see the bug-fix comment on
  // the latter) so "Accept & use" behaves identically either way.
  const acceptLegalCheck = async () => {
    if (!legalCheck) return;
    const id = legalCheck.item.id;
    if (isBusy(id)) return;   // guards a double-click on "Accept & use" firing two installs
    if (legalCheck.tabKey === "skills") {
      setItemBusy(id, true);
      try {
        const result = await skillsApi.install(id);
        await loadSkills();
        // A skill nobody had installed before this had a synthetic
        // browse-cache id (see marketplaceStore.js / services/
        // marketplace_skill_ingestion.py's "browse vs. store" design) —
        // installing it just gave it a real, permanent id. If its detail
        // page is open, follow it to the new id so the page doesn't bounce
        // back to the grid (Marketplace.jsx's detail-lookup treats an
        // unresolvable id as "gone").
        if (result?.id && result.id !== id) {
          setDetail((d) => (d && d.kind === "skills" && d.id === id ? { ...d, id: result.id } : d));
        }
        toast.success(`${legalCheck.item.name} is now available in chat.`);
      } catch (e) {
        toast.error(e.message || "Couldn't enable this skill for chat.");
      } finally {
        setItemBusy(id, false);
      }
    } else {
      toggleInstalled(singular[legalCheck.tabKey], id);
      bump();
      toast.success(`${legalCheck.item.name} is now available in chat.`);
    }
    setLegalCheck(null);
  };
  const doToggleInstall = (item) => requestUse(activeTab, item);
  // Takes an explicit tabKey rather than closing over `activeTab` — a skill
  // opened by clicking through a Plugin's bundle link has detail.kind
  // "skills" while activeTab is still "plugins"; using activeTab here would
  // silently delete/save against the wrong store.
  const doDelete = async (tabKey, item) => {
    const ok = await confirm({
      title: `Delete ${singular[tabKey]}`,
      message: `Remove "${item.name}" permanently? This cannot be undone.`,
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    if (tabKey === "skills") {
      try {
        await skillsApi.remove(item.id);
        await loadSkills();
      } catch (e) {
        toast.error(e.message || "Couldn't delete this skill.");
        return;
      }
    } else {
      TABS.find((t) => t.key === tabKey).store.remove(item.id);
    }
    bump();
    setDetail(null);
    toast.success(`${item.name} deleted.`);
  };
  const doSave = (data, existing) => {
    if (existing) {
      tab.store.update(existing.id, data);
      toast.success(`${data.name} updated.`);
    } else {
      tab.store.create({ ...data, author: myIdentity });
      toast.success(`${data.name} created.`);
    }
    bump();
    setCreateOpen(false);
    setEditItem(null);
  };
  const openCreate = () => {
    if (activeTab === "skills") setSkillForm({ existing: null });
    else { setEditItem(null); setCreateOpen(true); }
  };
  const doSaveSkill = async (data, existing) => {
    try {
      let saved;
      if (existing) {
        // Server increments `version` itself now — no client-side bump.
        saved = await skillsApi.update(existing.id, data);
        toast.success(`${data.name} updated.`);
      } else {
        saved = await skillsApi.create(data);
        toast.success(`${data.name} created.`);
      }
      await loadSkills();
      setSkillForm(null);
      // Land on the saved skill's own detail page (not the main grid) — one
      // step back, not two, and it doubles as immediate visual confirmation
      // of what was just created/edited.
      setDetail({ kind: "skills", id: saved.id });
    } catch (e) {
      toast.error(e.message || "Couldn't save this skill.");
    }
  };
  // Batch upload — each valid parsed file becomes its own skill (this is why
  // upload is a separate flow from the single-item manual form: one form has
  // one name/description, but a drag-and-drop can carry several unrelated
  // skill files at once).
  const doUploadSkills = async (parsedList) => {
    try {
      await skillsApi.upload(parsedList.map((p) => ({
        name: p.name, description: p.description, instructions: p.instructions, files: p.files || [],
      })));
      await loadSkills();
      setSkillUploadOpen(false);
      toast.success(`${parsedList.length} skill${parsedList.length !== 1 ? "s" : ""} uploaded.`);
    } catch (e) {
      toast.error(e.message || "Couldn't upload these skills.");
    }
  };

  // ── Full-page: create/edit a skill (manual form) ──────────────────────
  if (skillForm) {
    return (
      <SkillFormPage
        existing={skillForm.existing}
        onCancel={() => setSkillForm(null)}
        onSave={doSaveSkill}
      />
    );
  }

  // ── Full-page: batch-upload one or more SKILL.md files ────────────────
  if (skillUploadOpen) {
    return (
      <SkillUploadPage
        onCancel={() => setSkillUploadOpen(false)}
        onUpload={doUploadSkills}
      />
    );
  }

  // ── Full-page detail view ─────────────────────────────────────────────
  if (detail) {
    const dTab = TABS.find((t) => t.key === detail.kind);
    const item = detail.kind === "skills"
      ? skillsItems.find((x) => x.id === detail.id)
      : dTab.store.get(detail.id);
    if (!item) {
      // Skills load asynchronously — don't bounce back to the grid while
      // the list is still loading (e.g. a deep link opened before the
      // initial fetch resolves); only bail once we know it's really gone.
      if (detail.kind === "skills" && skillsLoading) {
        return <div className="flex items-center justify-center h-full text-sm text-gray-400">Loading…</div>;
      }
      setDetail(null);
      return null;
    }
    const canManageItem = item.author === myIdentity;
    if (detail.kind === "skills") {
      // BUG FIX: ThirdPartyCheckModal (tied to `legalCheck` state) previously
      // only rendered in the main "browse" return below — this early return
      // for the detail page never reached it, so requestUse() would set
      // legalCheck correctly (verified via direct debugging) but the modal
      // itself never appeared when "Use in chat" was clicked from a skill's
      // detail page (only worked from the grid card's own install button).
      // Pre-existing bug, not introduced by Phases 1-4 — fixed by rendering
      // the modal as a sibling here too, not just in the main return.
      return (
        <>
          <SkillDetailPage
            item={item}
            installed={!!item.installed}
            canManage={canManageItem}
            busy={isBusy(item.id)}
            onBack={() => setDetail(null)}
            onToggleInstall={() => requestUse("skills", item)}
            onEdit={() => setSkillForm({ existing: item })}
            onDelete={() => doDelete("skills", item)}
          />
          {legalCheck && (
            <ThirdPartyCheckModal
              item={legalCheck.item}
              busy={isBusy(legalCheck.item.id)}
              onCancel={() => setLegalCheck(null)}
              onAccept={acceptLegalCheck}
            />
          )}
        </>
      );
    }
    return (
      <DetailPage
        tabKey={detail.kind}
        item={item}
        installed={isInstalled(singular[detail.kind], item.id)}
        canManage={canManageItem}
        allSkills={skillsItems}
        onBack={() => setDetail(null)}
        onToggleInstall={() => requestUse(detail.kind, item)}
        onEdit={() => { setEditItem(item); setCreateOpen(true); }}
        onDelete={() => doDelete(detail.kind, item)}
        onOpenLinked={(k, id) => setDetail({ kind: k, id })}
      />
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto bg-white text-gray-800">
      <div className="px-6 pt-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Marketplace</h1>

        {/* Primary tabs + Yours/Discover scope toggle */}
        <div className="flex items-center gap-1 mb-4 flex-wrap">
          {TABS.map((t) => {
            const isActive = activeTab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => { setActiveTab(t.key); setSearch(""); setCategory("all"); setAddMenuOpen(false); }}
                className={`px-3.5 py-1.5 text-sm rounded-lg transition-all duration-150 cursor-pointer ${
                  isActive ? "bg-gray-100 text-gray-900 font-semibold" : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                }`}
              >
                {t.label}
              </button>
            );
          })}
          {/* On Skills, "Discover" (default) shows the two-section SkillsHome
              layout below; "Yours" narrows to a flat grid of skills you
              created or are using — same semantics as Connectors/Plugins. */}
          <div className="w-px h-5 bg-gray-200 mx-2" />
          <div className="flex items-center bg-gray-100 rounded-full p-0.5">
            {["yours", "discover"].map((s) => (
              <button
                key={s}
                onClick={() => { setScope(s); setCategory("all"); }}
                className={`px-3.5 py-1 text-xs rounded-full transition-all duration-150 cursor-pointer capitalize ${
                  scope === s ? "bg-white text-gray-900 font-semibold shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Search + category dropdown + sort + add */}
        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex-1 max-w-md">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${activeTab}…`}
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 bg-white shadow-sm transition"
            />
          </div>

          <div className="relative">
            <button
              onClick={() => setCategoryMenuOpen((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition cursor-pointer capitalize ${
                category !== "all" ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {category === "all" ? "Category" : category}
              <ChevronDown className={`w-3 h-3 transition-transform ${categoryMenuOpen ? "rotate-180" : ""}`} />
            </button>
            {categoryMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setCategoryMenuOpen(false)} />
                <div className="absolute left-0 mt-1.5 w-56 max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-lg py-1 z-20">
                  <button
                    onClick={() => { setCategory("all"); setCategoryMenuOpen(false); }}
                    className={`w-full flex items-center justify-between px-3 py-1.5 text-sm text-left transition cursor-pointer ${
                      category === "all" ? "bg-indigo-50 text-indigo-700 font-medium" : "text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    All {category === "all" && <Check className="w-3.5 h-3.5" />}
                  </button>
                  {tab.categories.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => { setCategory(cat); setCategoryMenuOpen(false); }}
                      className={`w-full flex items-center justify-between px-3 py-1.5 text-sm text-left transition cursor-pointer ${
                        category === cat ? "bg-indigo-50 text-indigo-700 font-medium" : "text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      {cat}
                      {category === cat && <Check className="w-3.5 h-3.5" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <button
            onClick={() => setSortDesc((v) => !v)}
            title={sortDesc ? "Sorted Z → A" : "Sorted A → Z"}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition cursor-pointer flex-shrink-0"
          >
            <ArrowUpDown className={`w-3.5 h-3.5 transition-transform ${sortDesc ? "rotate-180" : ""}`} />
          </button>

          <div className="flex-1" />

          {!isBrowsing && <span className="text-xs text-gray-400 flex-shrink-0">{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>}

          {activeTab === "skills" ? (
            <div className="relative flex-shrink-0">
              <button
                onClick={() => setAddMenuOpen((v) => !v)}
                className="flex items-center gap-1.5 px-3.5 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-all duration-150 cursor-pointer shadow-sm hover:shadow"
              >
                <Plus className="w-3.5 h-3.5" /> Add <ChevronDown className="w-3 h-3" />
              </button>
              {addMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setAddMenuOpen(false)} />
                  <div className="absolute right-0 mt-1.5 w-64 bg-white border border-gray-200 rounded-xl shadow-lg py-1.5 z-20">
                    <button
                      onClick={() => { setAddMenuOpen(false); setSkillUploadOpen(true); }}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition cursor-pointer"
                    >
                      <Upload className="w-4 h-4 text-indigo-500 flex-shrink-0" /> Upload skill
                    </button>
                    <button
                      onClick={() => { setAddMenuOpen(false); openCreate(); }}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition cursor-pointer"
                    >
                      <Pencil className="w-4 h-4 text-indigo-500 flex-shrink-0" /> Create a skill
                    </button>
                    <div className="border-t border-gray-100 my-1" />
                    <button
                      onClick={() => { setAddMenuOpen(false); createSkillWithAiNxt(); }}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition cursor-pointer"
                    >
                      <Sparkles className="w-4 h-4 text-indigo-500 flex-shrink-0" /> Create with AiNxt
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <button
              onClick={openCreate}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-all duration-150 cursor-pointer shadow-sm hover:shadow flex-shrink-0"
            >
              <Plus className="w-3.5 h-3.5" /> Create
            </button>
          )}
        </div>
      </div>

      <div className="px-6 pb-6 animate-fadeIn">
        {activeTab === "skills" && skillsLoading ? (
          <div className="flex items-center justify-center h-56 text-sm text-gray-400">Loading skills…</div>
        ) : activeTab === "skills" && skillsError ? (
          <div className="flex flex-col items-center justify-center h-56 text-center gap-3">
            <p className="text-sm text-red-500">{skillsError}</p>
            <button
              onClick={loadSkills}
              className="px-3.5 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition cursor-pointer"
            >
              Retry
            </button>
          </div>
        ) : isBrowsing && activeTab === "skills" ? (
          <SkillsHome
            items={scoped}
            accent={tab.accent}
            myIdentity={myIdentity}
            busyIds={busyIds}
            onOpen={openDetail}
            onUse={(item) => requestUse("skills", item)}
            onCreate={openCreate}
          />
        ) : isBrowsing ? (
          <BrowseSections
            tabKey={activeTab}
            accent={tab.accent}
            items={scoped}
            categories={categories}
            busyIds={busyIds}
            onOpen={openDetail}
            onToggleInstall={doToggleInstall}
            onPickCategory={setCategory}
            onCreate={openCreate}
          />
        ) : filtered.length === 0 ? (
          <EmptyState text={`No ${activeTab} match your filters`} onCreate={openCreate} />
        ) : (
          <ItemGrid tabKey={activeTab} accent={tab.accent} items={filtered} busyIds={busyIds} onOpen={openDetail} onToggleInstall={doToggleInstall} />
        )}
      </div>

      {createOpen && (
        <CreateItemModal
          tabKey={activeTab}
          existing={editItem}
          allSkills={skillsItems}
          allConnectors={connectorsStore.list()}
          onClose={() => { setCreateOpen(false); setEditItem(null); }}
          onSave={doSave}
        />
      )}

      {legalCheck && (
        <ThirdPartyCheckModal
          item={legalCheck.item}
          busy={isBusy(legalCheck.item.id)}
          onCancel={() => setLegalCheck(null)}
          onAccept={acceptLegalCheck}
        />
      )}
    </div>
  );
}

// ── Browse layout (Claude-style: For You / New / Most installed / Categories) ──

function BrowseSections({ tabKey, accent, items, categories, busyIds, onOpen, onToggleInstall, onPickCategory, onCreate }) {
  const kind = singular[tabKey];
  const byRecent = useMemo(() => [...items].sort((a, b) => b.createdAt - a.createdAt), [items]);
  const byInstalls = useMemo(() => [...items].sort((a, b) => (b.installs || 0) - (a.installs || 0)), [items]);
  const forYou = useMemo(() => {
    const installedCats = new Set(items.filter((i) => isInstalled(kind, i.id)).map((i) => i.category));
    const matched = items.filter((i) => installedCats.has(i.category) && !isInstalled(kind, i.id));
    return (matched.length ? matched : byRecent).slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  if (items.length === 0) {
    return <EmptyState text={`No ${tabKey} yet`} onCreate={onCreate} />;
  }

  return (
    <div className="space-y-8">
      <SectionRow title="For you" items={forYou} tabKey={tabKey} accent={accent} busyIds={busyIds} onOpen={onOpen} onToggleInstall={onToggleInstall} />
      <SectionRow title={`New ${tabKey}`} items={byRecent.slice(0, 6)} tabKey={tabKey} accent={accent} busyIds={busyIds} onOpen={onOpen} onToggleInstall={onToggleInstall} />
      <SectionRow title="Most installed" items={byInstalls.slice(0, 6)} tabKey={tabKey} accent={accent} busyIds={busyIds} onOpen={onOpen} onToggleInstall={onToggleInstall} />

      {categories.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Categories</h2>
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <button
                key={c.name}
                onClick={() => onPickCategory(c.name)}
                className="flex items-center gap-1.5 px-3.5 py-2 text-sm rounded-xl border border-gray-200 bg-white hover:border-indigo-200 hover:shadow-sm transition-all duration-150 cursor-pointer"
              >
                <span className="font-medium text-gray-700">{c.name}</span>
                <span className="text-xs text-gray-400">{c.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionRow({ title, items, tabKey, accent, busyIds, onOpen, onToggleInstall }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-700 mb-3">{title}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3.5">
        {items.map((item) => (
          <ItemCard key={item.id} tabKey={tabKey} accent={accent} item={item} busy={busyIds?.has(item.id)} onOpen={() => onOpen(item.id)} onToggleInstall={() => onToggleInstall(item)} />
        ))}
      </div>
    </div>
  );
}

function ItemGrid({ tabKey, accent, items, busyIds, onOpen, onToggleInstall }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3.5">
      {items.map((item) => (
        <ItemCard key={item.id} tabKey={tabKey} accent={accent} item={item} busy={busyIds?.has(item.id)} onOpen={() => onOpen(item.id)} onToggleInstall={() => onToggleInstall(item)} />
      ))}
    </div>
  );
}

// ── Skills tab home: "Skills created by you" + "Skills from third parties" ──
// The other two tabs still use the generic For You/New/Most installed/
// Categories BrowseSections above — this replaces that ONLY for Skills, per
// the current design direction (Skills first, Connectors/Plugins later).

function SkillsHome({ items, accent, myIdentity, busyIds, onOpen, onUse, onCreate }) {
  const mine = items.filter((i) => i.author === myIdentity);
  const thirdParty = items.filter((i) => i.thirdParty);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Skills created by you</h2>
        {mine.length === 0 ? (
          <EmptyState text="You haven't created any skills yet" onCreate={onCreate} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3.5">
            {mine.map((item) => (
              <ItemCard key={item.id} tabKey="skills" accent={accent} item={item} busy={busyIds?.has(item.id)} onOpen={() => onOpen(item.id)} onToggleInstall={() => onUse(item)} />
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Skills from third parties</h2>
        <p className="text-xs text-gray-400 mb-3">
          Published by outside vendors, not AiNxt. Using one for the first time runs a legal &amp; compatibility check.
        </p>
        {thirdParty.length === 0 ? (
          <p className="text-sm text-gray-400">None available yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3.5">
            {thirdParty.map((item) => (
              <ItemCard key={item.id} tabKey="skills" accent={accent} item={item} busy={busyIds?.has(item.id)} onOpen={() => onOpen(item.id)} onToggleInstall={() => onUse(item)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ text, onCreate }) {
  return (
    <div className="flex flex-col items-center justify-center h-56 text-gray-400 text-center px-4">
      <div className="w-14 h-14 rounded-2xl bg-gray-50 flex items-center justify-center mb-3 text-2xl">🧭</div>
      <p className="text-sm font-medium text-gray-500 mb-3">{text}</p>
      <button
        onClick={onCreate}
        className="flex items-center gap-1.5 px-3.5 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition cursor-pointer"
      >
        <Plus className="w-3.5 h-3.5" /> Create the first one
      </button>
    </div>
  );
}

// ── Cards ─────────────────────────────────────────────────────────────────

function ItemCard({ tabKey, accent, item, busy, onOpen, onToggleInstall }) {
  const kind = singular[tabKey];
  const added = tabKey === "skills" ? !!item.installed : isInstalled(kind, item.id);
  const licenseBlocked = tabKey === "skills" && !added && !isSkillLicenseUsable(item);
  const useTitle = busy
    ? "Working…"
    : licenseBlocked
    ? "No verified MIT-compatible license on file — this skill can't be used in chat"
    : tabKey === "skills"
    ? (added ? "Remove from chat" : "Use in chat")
    : (added ? "Remove from Yours" : "Add to Yours");
  return (
    <div
      onClick={onOpen}
      className={`group flex gap-3 p-4 rounded-2xl border border-gray-200 bg-white hover:shadow-md ${ACCENT_BORDER_HOVER[accent]} hover:-translate-y-0.5 transition-all duration-150 cursor-pointer`}
    >
      <div className={`w-10 h-10 rounded-xl ${ACCENT_CHIP[accent]} flex items-center justify-center flex-shrink-0 shadow-sm text-lg`}>
        {item.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className={`font-semibold text-sm text-gray-900 truncate group-hover:${ACCENT_TEXT[accent]} transition-colors`}>{item.name}</h3>
          <button
            onClick={(e) => { e.stopPropagation(); if (!licenseBlocked && !busy) onToggleInstall(); }}
            title={useTitle}
            disabled={licenseBlocked || busy}
            className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-150 ${
              licenseBlocked ? "bg-gray-50 border border-gray-200 text-gray-300 cursor-not-allowed"
              : busy ? "bg-gray-100 border border-gray-200 text-gray-400 cursor-wait"
              : added ? "bg-green-500 hover:bg-green-600 text-white cursor-pointer"
              : "bg-gray-100 hover:bg-indigo-100 hover:text-indigo-600 border border-gray-200 text-gray-500 cursor-pointer"
            }`}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : added ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{item.description}</p>
        <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">{item.category}</span>
          {item.thirdParty && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium">Third-party</span>
          )}
          {item.securityStatus === "caution" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 font-medium">⚠ Review flagged</span>
          )}
          {item.securityStatus === "blocked" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-700 font-medium">⛔ Blocked</span>
          )}
          {item.thirdParty && !isSkillLicenseUsable(item) && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-700 font-medium">
              ⛔ {item.license ? "License incompatible" : "No license on file"}
            </span>
          )}
          <span className="text-[11px] text-gray-400 truncate">by {item.author} · {item.installs || 0} installs</span>
        </div>
      </div>
    </div>
  );
}

// ── Full-page detail ─────────────────────────────────────────────────────

function DetailPage({ tabKey, item, installed, canManage, allSkills, onBack, onToggleInstall, onEdit, onDelete, onOpenLinked }) {
  const accent = TABS.find((t) => t.key === tabKey).accent;
  const kind = singular[tabKey];
  const linkedSkills = kind === "plugin" ? (item.skillIds || []).map((id) => (allSkills || []).find((s) => s.id === id)).filter(Boolean) : [];
  const linkedConnectors = kind === "plugin" ? (item.connectorIds || []).map((id) => connectorsStore.get(id)).filter(Boolean) : [];

  return (
    <div className="flex flex-col h-full overflow-auto bg-white text-gray-800">
      <div className="px-6 pt-6 pb-4 border-b border-gray-100">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 transition cursor-pointer mb-4">
          <ChevronLeft className="w-4 h-4" /> Back to Marketplace
        </button>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className={`w-16 h-16 rounded-2xl ${ACCENT_CHIP[accent]} flex items-center justify-center flex-shrink-0 shadow-sm text-3xl`}>
              {item.icon}
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">{item.name}</h1>
              <div className="flex items-center gap-2 mt-1 text-xs text-gray-400 flex-wrap">
                <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">{item.category}</span>
                {item.thirdParty && <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium">Third-party</span>}
                <span>by {item.author}</span>
                <span>·</span>
                <span>{timeAgo(item.createdAt)}</span>
                <span>·</span>
                <span>{item.installs || 0} installs</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {canManage && (
              <>
                <button onClick={onEdit} className="p-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition cursor-pointer" title="Edit">
                  <Pencil className="w-4 h-4" />
                </button>
                <button onClick={onDelete} className="p-2 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 transition cursor-pointer" title="Delete">
                  <Trash2 className="w-4 h-4" />
                </button>
              </>
            )}
            <button
              onClick={onToggleInstall}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition cursor-pointer ${
                installed ? "bg-green-50 text-green-700 border border-green-200 hover:bg-green-100" : "bg-indigo-600 hover:bg-indigo-700 text-white"
              }`}
            >
              {installed ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
              {kind === "skill" ? (installed ? "In use" : "Use in chat") : (installed ? "Added" : "Add to Yours")}
            </button>
          </div>
        </div>
      </div>

      <div className="px-6 py-6 max-w-2xl space-y-6">
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Description</h3>
          <p className="text-sm text-gray-700 leading-relaxed">{item.description}</p>
        </div>

        {(item.tags || []).length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Tags</h3>
            <div className="flex flex-wrap gap-1.5">
              {item.tags.map((t) => <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{t}</span>)}
            </div>
          </div>
        )}

        {kind === "skill" && (
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Instructions</h3>
            <div className="text-sm text-gray-700 leading-relaxed bg-gray-50 border border-gray-100 rounded-xl p-4 whitespace-pre-wrap">
              {item.instructions || "No instructions provided."}
            </div>
          </div>
        )}

        {kind === "connector" && (
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Connection details</h3>
            <div className="text-sm text-gray-700 space-y-1.5 bg-gray-50 border border-gray-100 rounded-xl p-4">
              <div><span className="text-gray-400">Base URL</span> · {item.baseUrl || "—"}</div>
              <div><span className="text-gray-400">Auth type</span> · <span className="capitalize">{(item.authType || "").replace(/_/g, " ")}</span></div>
            </div>
            <p className="text-xs text-gray-400 mt-2">This is a UI preview — connecting isn't wired up to a real backend yet.</p>
          </div>
        )}

        {kind === "plugin" && (
          <div className="space-y-4">
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Includes {linkedSkills.length} skill{linkedSkills.length !== 1 ? "s" : ""}</h3>
              {linkedSkills.length === 0 ? <p className="text-xs text-gray-400">None bundled.</p> : (
                <div className="space-y-1.5">
                  {linkedSkills.map((s) => (
                    <button key={s.id} onClick={() => onOpenLinked("skills", s.id)} className="w-full flex items-center gap-2.5 text-left text-sm bg-gray-50 hover:bg-gray-100 border border-gray-100 rounded-lg px-3 py-2 transition cursor-pointer">
                      <span className="text-base">{s.icon}</span> <span className="font-medium text-gray-800">{s.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Includes {linkedConnectors.length} connector{linkedConnectors.length !== 1 ? "s" : ""}</h3>
              {linkedConnectors.length === 0 ? <p className="text-xs text-gray-400">None bundled.</p> : (
                <div className="space-y-1.5">
                  {linkedConnectors.map((c) => (
                    <button key={c.id} onClick={() => onOpenLinked("connectors", c.id)} className="w-full flex items-center gap-2.5 text-left text-sm bg-gray-50 hover:bg-gray-100 border border-gray-100 rounded-lg px-3 py-2 transition cursor-pointer">
                      <span className="text-base">{c.icon}</span> <span className="font-medium text-gray-800">{c.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Skill detail page (Overview / Contents tabs) ─────────────────────────
// Click a skill card → this preview page opens first (read-only, matching
// Claude's own skill detail: an Overview tab with description/publisher
// info, and a Contents tab that renders the actual SKILL.md). Editing is a
// deliberate separate step — the "⋮" menu or the Contents tab's own Edit
// button — never the click-to-open action itself.

function ToggleSwitch({ on, onClick, disabled, busy, title }) {
  return (
    <button
      onClick={busy ? undefined : onClick}
      disabled={disabled || busy}
      title={busy ? "Working…" : title}
      className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer disabled:cursor-default disabled:opacity-40 ${on ? "bg-indigo-600" : "bg-gray-200"}`}
    >
      {busy
        ? <Loader2 className="absolute top-0.5 left-0.5 w-4 h-4 text-gray-400 animate-spin" />
        : <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${on ? "translate-x-4" : "translate-x-0"}`} />}
    </button>
  );
}

function SkillDetailPage({ item, installed, canManage, busy, onBack, onToggleInstall, onEdit, onDelete }) {
  const [tab, setTab] = useState("overview"); // "overview" | "contents"
  const [contentView, setContentView] = useState("preview"); // "preview" | "raw"
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState("SKILL.md");

  const isNew = canManage && Date.now() - item.createdAt < 3 * 86400000;
  const md = buildSkillMarkdown(item);
  const supportingFiles = item.files || [];
  const fileCount = 1 + supportingFiles.length;
  const activeSupportingFile = supportingFiles.find((f) => f.name === selectedFile) || null;

  const downloadText = (filename, content) => {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const download = () => {
    if (selectedFile === "SKILL.md") {
      downloadText(`${item.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.SKILL.md`, md);
    } else if (activeSupportingFile && !activeSupportingFile.binary) {
      downloadText(activeSupportingFile.name, activeSupportingFile.content);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-auto bg-white text-gray-800">
      <div className="px-6 pt-6">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 transition cursor-pointer mb-5">
          <ChevronLeft className="w-4 h-4" /> Back to Marketplace
        </button>

        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl brand-grad-vivid flex items-center justify-center text-xl flex-shrink-0">{item.icon}</div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-bold text-gray-900 truncate">{item.name}</h1>
                {isNew && <span className="px-2 py-0.5 text-[10px] font-semibold bg-blue-100 text-blue-700 rounded flex-shrink-0">New</span>}
                {item.thirdParty && <span className="px-2 py-0.5 text-[10px] font-semibold bg-amber-50 text-amber-700 rounded flex-shrink-0">Third-party</span>}
                {item.securityStatus === "caution" && (
                  <span title="This skill's content triggered a security review flag — check the instructions before use." className="px-2 py-0.5 text-[10px] font-semibold bg-orange-50 text-orange-700 rounded flex-shrink-0">⚠ Review flagged</span>
                )}
                {item.securityStatus === "blocked" && (
                  <span title="This skill failed a security review and cannot be used in chat." className="px-2 py-0.5 text-[10px] font-semibold bg-red-50 text-red-700 rounded flex-shrink-0">⛔ Blocked</span>
                )}
                {item.thirdParty && !isSkillLicenseUsable(item) && (
                  <span title={item.license ? `Licensed under ${item.license} — not compatible with this project's MIT license.` : "No verified license on file for this skill — it can't be used in chat."}
                    className="px-2 py-0.5 text-[10px] font-semibold bg-red-50 text-red-700 rounded flex-shrink-0">
                    ⛔ {item.license ? "License incompatible" : "No license on file"}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                by {canManage ? "you" : item.author} · v{item.version || 1} · updated {timeAgo(item.updatedAt)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <ToggleSwitch on={installed} onClick={onToggleInstall} busy={busy}
              disabled={item.securityStatus === "blocked" || !isSkillLicenseUsable(item)}
              title={item.securityStatus === "blocked" ? "Blocked by security review"
                : !isSkillLicenseUsable(item) ? (item.license ? "Blocked — license incompatible with this project's MIT license" : "Blocked — no verified license on file for this skill")
                : (installed ? "Remove from chat" : "Use in chat")} />
            {canManage && (
              <div className="relative">
                <button onClick={() => setMenuOpen((v) => !v)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition cursor-pointer">
                  <MoreVertical className="w-4 h-4" />
                </button>
                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                    <div className="absolute right-0 mt-1 w-36 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-20">
                      <button onClick={() => { setMenuOpen(false); onEdit(); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 transition cursor-pointer">
                        <Pencil className="w-3.5 h-3.5" /> Edit
                      </button>
                      <button onClick={() => { setMenuOpen(false); onDelete(); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 transition cursor-pointer">
                        <Trash2 className="w-3.5 h-3.5" /> Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-5 border-b border-gray-100">
          {["overview", "contents"].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`pb-2.5 text-sm font-medium capitalize transition cursor-pointer ${tab === t ? "border-b-2 border-indigo-600 text-indigo-700" : "text-gray-400 hover:text-gray-600"}`}
            >
              {t === "overview" ? "Overview" : `Contents · ${fileCount}`}
            </button>
          ))}
        </div>
      </div>

      {tab === "overview" ? (
        <div className="px-6 py-6 flex gap-10 flex-wrap">
          <div className="flex-1 min-w-[280px] max-w-2xl">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Description</h3>
            <p className="text-sm text-gray-700 leading-relaxed">{item.description}</p>
            {(item.tags || []).length > 0 && (
              <div className="mt-5">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Tags</h3>
                <div className="flex flex-wrap gap-1.5">
                  {item.tags.map((t) => <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{t}</span>)}
                </div>
              </div>
            )}
          </div>
          <div className="w-64 flex-shrink-0 space-y-5">
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Created by</h3>
              <div className="flex items-center gap-2 text-sm text-gray-700">
                <span className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0"><User className="w-3.5 h-3.5 text-gray-500" /></span>
                {canManage ? "You" : item.author}
              </div>
            </div>
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Connectors &amp; tools</h3>
              <div className="flex items-center gap-2 text-sm text-gray-700">
                <span className="w-6 h-6 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0"><Plug className="w-3.5 h-3.5 text-gray-500" /></span>
                <span className="flex-1">Only adds instructions for the model</span>
                <Info className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="px-6 py-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-gray-600">{item.name} · v{item.version || 1} · current</span>
            <div className="flex items-center gap-2">
              <button onClick={download} title={`Download ${selectedFile}`} disabled={activeSupportingFile?.binary} className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
                <Download className="w-4 h-4" />
              </button>
              {canManage && (
                <button onClick={onEdit} className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition cursor-pointer">Edit</button>
              )}
            </div>
          </div>
          <div className="flex border border-gray-200 rounded-xl overflow-hidden min-h-[320px]">
            <div className="w-40 border-r border-gray-100 bg-gray-50 flex-shrink-0">
              <button
                onClick={() => setSelectedFile("SKILL.md")}
                className={`w-full text-left px-3 py-2.5 text-sm font-medium border-b border-gray-100 flex items-center gap-1.5 transition cursor-pointer ${selectedFile === "SKILL.md" ? "bg-white text-gray-800" : "text-gray-500 hover:bg-white/60"}`}
              >
                <FileText className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" /> SKILL.md
              </button>
              {supportingFiles.map((f) => (
                <button
                  key={f.name}
                  onClick={() => setSelectedFile(f.name)}
                  className={`w-full text-left px-3 py-2.5 text-sm border-b border-gray-100 flex items-center gap-1.5 transition cursor-pointer ${selectedFile === f.name ? "bg-white text-gray-800 font-medium" : "text-gray-500 hover:bg-white/60"}`}
                >
                  <FileText className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" /> <span className="truncate">{f.name}</span>
                </button>
              ))}
            </div>
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 flex-shrink-0">
                <code className="text-xs text-gray-400">/{selectedFile}</code>
                {selectedFile === "SKILL.md" && (
                  <div className="flex items-center bg-gray-100 rounded-md p-0.5">
                    <button onClick={() => setContentView("preview")} title="Preview" className={`p-1 rounded transition cursor-pointer ${contentView === "preview" ? "bg-white shadow-sm" : ""}`}>
                      <Eye className="w-3.5 h-3.5 text-gray-600" />
                    </button>
                    <button onClick={() => setContentView("raw")} title="Raw" className={`p-1 rounded transition cursor-pointer ${contentView === "raw" ? "bg-white shadow-sm" : ""}`}>
                      <Code2 className="w-3.5 h-3.5 text-gray-600" />
                    </button>
                  </div>
                )}
              </div>
              <div className="p-4 overflow-auto flex-1">
                {selectedFile === "SKILL.md" ? (
                  contentView === "preview" ? (
                    <div className="prose prose-sm max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
                    </div>
                  ) : (
                    <pre className="text-xs font-mono text-gray-700 whitespace-pre-wrap">{md}</pre>
                  )
                ) : activeSupportingFile?.binary ? (
                  <p className="text-sm text-gray-400">
                    Binary file ({Math.max(1, Math.round(activeSupportingFile.size / 1024))} KB) — preview isn't available in this UI-only mock yet.
                  </p>
                ) : (
                  <pre className="text-xs font-mono text-gray-700 whitespace-pre-wrap">{activeSupportingFile?.content}</pre>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Skill form (full page, not a modal) ─────────────────────────────────
// Covers both "Create a skill" and "Upload skill" — both Add-menu items land
// here. The crucial piece per the design: a SKILL.md file attachment that's
// parsed and validated against the required frontmatter format client-side
// (parseSkillMarkdown in marketplaceStore.js); anything that deviates throws
// a clear, specific error in the UI instead of silently accepting it.

// A lightweight code-editor look (monospace + line-number gutter) for the
// Instructions field — matches Claude's own create-skill editor without
// pulling in a full CodeMirror instance for what's still just plain text.
function LineNumberedTextarea({ value, onChange, placeholder }) {
  const textareaRef = useRef(null);
  const gutterRef = useRef(null);
  const lineCount = Math.max((value || "").split("\n").length, 12);
  const syncScroll = () => { if (gutterRef.current && textareaRef.current) gutterRef.current.scrollTop = textareaRef.current.scrollTop; };
  return (
    <div className="flex bg-gray-50 font-mono text-sm">
      <div ref={gutterRef} className="select-none text-right text-gray-300 px-2.5 py-3 overflow-hidden flex-shrink-0" style={{ minWidth: "2.75rem" }}>
        {Array.from({ length: lineCount }, (_, i) => <div key={i} className="leading-6">{i + 1}</div>)}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={onChange}
        onScroll={syncScroll}
        placeholder={placeholder}
        rows={12}
        spellCheck={false}
        className="flex-1 px-3 py-3 bg-transparent outline-none resize-none leading-6 min-w-0"
      />
    </div>
  );
}

// Text-ish files can be stored and previewed inline (localStorage-backed, no
// real backend yet); anything else is still attached to the skill by name so
// the bundle is honest about what it contains, just without a body to show.
const TEXT_FILE_EXT = /\.(md|markdown|txt|json|js|jsx|ts|tsx|py|sh|yml|yaml|csv|xml|html|css)$/i;
function looksLikeTextFileName(name) {
  return TEXT_FILE_EXT.test(name);
}
function looksLikeTextFile(file) {
  return file.type.startsWith("text/") || file.type === "application/json" || looksLikeTextFileName(file.name);
}

function SkillFormPage({ existing, onCancel, onSave }) {
  const [name, setName] = useState(existing?.name || "");
  const [description, setDescription] = useState(existing?.description || "");
  const [instructions, setInstructions] = useState(existing?.instructions || "");
  const [category, setCategory] = useState(existing?.category || SKILL_CATEGORIES[0]);
  const [icon, setIcon] = useState(existing?.icon || SKILL_ICONS[0]);
  const [tags, setTags] = useState((existing?.tags || []).join(", "));
  const [moreOpen, setMoreOpen] = useState(false);
  const [formError, setFormError] = useState("");
  // Supporting files bundled alongside the mandatory SKILL.md (matches
  // Claude desktop's own Create-a-skill flow: SKILL.md is required and typed
  // in directly via Name/Description/Instructions above; anything additional
  // — references, scripts, templates — attaches here as separate files).
  const [files, setFiles] = useState(existing?.files || []);
  const [fileNote, setFileNote] = useState("");
  const [expandedFile, setExpandedFile] = useState(null); // name of the file currently open for view/edit
  const fileInputRef = useRef(null);

  const handleAddFiles = (e) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    picked.forEach((file) => {
      if (looksLikeTextFile(file)) {
        const reader = new FileReader();
        reader.onload = () => {
          setFiles((prev) => [...prev.filter((f) => f.name !== file.name), { name: file.name, content: String(reader.result || "") }]);
          setExpandedFile(file.name);
        };
        reader.onerror = () => setFileNote(`Couldn't read "${file.name}".`);
        reader.readAsText(file);
      } else {
        // Binary attachment — bundled by name only; this UI-only mock has no
        // backend to actually store the bytes yet.
        setFiles((prev) => [...prev.filter((f) => f.name !== file.name), { name: file.name, binary: true, size: file.size }]);
      }
    });
  };

  const removeFile = (fileName) => {
    setFiles((prev) => prev.filter((f) => f.name !== fileName));
    if (expandedFile === fileName) setExpandedFile(null);
  };

  const updateFileContent = (fileName, content) =>
    setFiles((prev) => prev.map((f) => (f.name === fileName ? { ...f, content } : f)));

  // Real SKILL.md spec limits (per Anthropic's docs): name <= 64 chars,
  // description <= 200 chars — description is the only signal the model
  // uses to decide whether a skill is relevant, so it's kept short on purpose.
  const canSave = name.trim() && name.trim().length <= 64 && description.trim() && description.trim().length <= 200 && instructions.trim();

  const submit = () => {
    if (!name.trim() || !description.trim() || !instructions.trim()) {
      setFormError("Skill name, description and instructions are all required.");
      return;
    }
    if (name.trim().length > 64) { setFormError(`Skill name must be 64 characters or fewer (currently ${name.trim().length}).`); return; }
    if (description.trim().length > 200) { setFormError(`Description must be 200 characters or fewer (currently ${description.trim().length}).`); return; }
    onSave({
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      category,
      icon,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      files,
    }, existing);
  };

  return (
    <div className="flex flex-col h-full overflow-auto bg-white text-gray-800">
      <div className="px-6 pt-6 pb-4 border-b border-gray-100">
        <button onClick={onCancel} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 transition cursor-pointer mb-4">
          <ChevronLeft className="w-4 h-4" /> Back to Marketplace
        </button>
        <h1 className="text-xl font-bold text-gray-900">{existing ? "Edit skill" : "Create a skill"}</h1>
        <p className="text-sm text-gray-500 mt-1">
          Have several ready-made <code className="bg-gray-100 px-1 rounded">SKILL.md</code> files? Use{" "}
          <span className="text-gray-700 font-medium">Add → Upload skill</span> instead.
        </p>
      </div>

      <div className="px-6 py-6 max-w-2xl space-y-5">
        <div className="flex items-start gap-2 p-3 bg-indigo-50 border border-indigo-100 rounded-lg text-xs text-indigo-900 leading-relaxed">
          <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            A SKILL.md file has two parts, and this form is exactly that: <strong>Skill name</strong> and{" "}
            <strong>Description</strong> become the file's header (the metadata at the very top); <strong>Instructions</strong>{" "}
            becomes everything below it — the actual body of the file.
          </span>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">Skill name</label>
            <span className={`text-xs ${name.length > 64 ? "text-red-500" : "text-gray-400"}`}>{name.length}/64</span>
          </div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly status report" maxLength={64}
            className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 transition" />
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">Description</label>
            <span className={`text-xs ${description.length > 200 ? "text-red-500" : "text-gray-400"}`}>{description.length}/200</span>
          </div>
          <p className="text-xs text-gray-400 mb-1.5">
            Header field. One line: what this does and when to use it — this is what the model checks to decide
            whether this skill applies. Not the steps themselves; those go in Instructions below.
          </p>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={200}
            placeholder="Generate weekly status reports from recent work. Use when asked for updates or progress summaries."
            className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 transition resize-none" />
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-800 mb-1.5">Instructions</label>
          <p className="text-xs text-gray-400 mb-1.5">
            Body of the file. The actual steps, format, or knowledge the model follows once this skill is active —
            everything Description summarized in one line, written out in full here.
          </p>
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <LineNumberedTextarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Summarize my recent work in three sections: wins, blockers, and next steps. Keep the tone professional but not stiff..."
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-semibold text-gray-800">
              Supporting files <span className="text-xs font-normal text-gray-400">(optional)</span>
            </label>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> Add file
            </button>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleAddFiles} />
          </div>
          <p className="text-xs text-gray-400 mb-2">
            If your instructions reference a template, script, or reference doc, attach it here so it ships with the
            skill. Click a file below to view or edit its contents.
          </p>
          {fileNote && <p className="text-xs text-red-500 mb-2">{fileNote}</p>}

          {files.length === 0 ? (
            <div className="px-3 py-4 border border-dashed border-gray-200 rounded-lg text-center text-xs text-gray-400">
              No supporting files attached.
            </div>
          ) : (
            <div className="space-y-1.5">
              {files.map((f) => {
                const expanded = expandedFile === f.name;
                return (
                  <div key={f.name} className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="flex items-center gap-2 px-2.5 py-1.5 bg-gray-50">
                      <FileText className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                      <button
                        onClick={() => !f.binary && setExpandedFile(expanded ? null : f.name)}
                        disabled={f.binary}
                        className={`flex-1 text-left truncate text-sm ${f.binary ? "text-gray-500 cursor-default" : "text-gray-700 hover:text-indigo-700 cursor-pointer"}`}
                      >
                        {f.name}
                      </button>
                      {f.binary ? (
                        <span className="text-[10px] text-gray-400 flex-shrink-0">binary · preview not available yet</span>
                      ) : (
                        <button
                          onClick={() => setExpandedFile(expanded ? null : f.name)}
                          title={expanded ? "Hide" : "View / edit"}
                          className="p-1 text-gray-400 hover:text-indigo-600 transition cursor-pointer flex-shrink-0"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button onClick={() => removeFile(f.name)} title="Remove" className="p-1 text-gray-400 hover:text-red-500 transition cursor-pointer flex-shrink-0">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {expanded && !f.binary && (
                      <textarea
                        value={f.content}
                        onChange={(e) => updateFileContent(f.name, e.target.value)}
                        rows={8}
                        spellCheck={false}
                        className="w-full px-3 py-2 text-xs font-mono text-gray-700 bg-white border-t border-gray-100 outline-none resize-none"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <button
            onClick={() => setMoreOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition cursor-pointer"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${moreOpen ? "rotate-180" : ""}`} />
            More options (icon, category, tags)
          </button>
          {moreOpen && (
            <div className="mt-3 space-y-3 p-3 bg-gray-50 border border-gray-100 rounded-lg">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Icon</label>
                <div className="flex flex-wrap gap-1.5">
                  {SKILL_ICONS.map((ic) => (
                    <button key={ic} onClick={() => setIcon(ic)} className={`w-8 h-8 rounded-lg flex items-center justify-center text-base border transition cursor-pointer ${icon === ic ? "border-indigo-400 bg-indigo-50" : "border-gray-200 bg-white hover:bg-gray-50"}`}>
                      {ic}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                  <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 transition bg-white">
                    {SKILL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tags (comma-separated)</label>
                  <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="demo, internal"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 transition bg-white" />
                </div>
              </div>
            </div>
          )}
        </div>

        {formError && <div className="p-2.5 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">{formError}</div>}

        <div className="flex items-center justify-between pb-6">
          <span className="px-2.5 py-1 text-xs font-medium bg-gray-100 text-gray-500 rounded-md">Draft</span>
          <div className="flex items-center gap-3">
            {!canSave && <span className="text-xs text-gray-400">Fill in skill name, description and instructions to continue.</span>}
            <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 cursor-pointer">Cancel</button>
            <button
              onClick={submit}
              disabled={!canSave}
              className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {existing ? "Save changes" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Skill upload (separate full page — batch, drag-and-drop) ─────────────
// A dedicated flow, distinct from SkillFormPage: uploading is about
// importing one or more already-written SKILL.md files at once (each one
// independently named/described), which doesn't fit a single-item form with
// one name/description pair. Each dropped .md is parsed and validated
// immediately (parseSkillMarkdown) so bad files are caught per-file, before
// any of them are saved.
//
// .zip / .skill packages ARE unpacked (via jszip) — matching Claude desktop,
// which lets a skill bundle SKILL.md plus supporting files (scripts,
// references, templates), optionally nested a folder deep. SKILL.md is
// located at the package root or one level in; every other file becomes a
// supporting file on the resulting skill, path preserved relative to
// wherever SKILL.md was found.

// SKILL.md at the zip root, or one folder deep (the common "zip of a single
// wrapping folder" export shape). Anything deeper isn't treated as the
// skill's entry point.
function findSkillMdEntry(entries) {
  return entries.find((f) => /(^|\/)SKILL\.md$/i.test(f.name) && f.name.split("/").filter(Boolean).length <= 2);
}

async function unzipSkillPackage(file) {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const skillMdEntry = findSkillMdEntry(entries);
  if (!skillMdEntry) {
    return { errors: ["No SKILL.md found at the root of the package (or one folder deep)."] };
  }
  const basePrefix = skillMdEntry.name.includes("/") ? skillMdEntry.name.slice(0, skillMdEntry.name.lastIndexOf("/") + 1) : "";
  const raw = await skillMdEntry.async("string");
  const result = parseSkillMarkdown(raw);

  const supportingFiles = [];
  for (const entry of entries) {
    if (entry === skillMdEntry) continue;
    const relName = entry.name.startsWith(basePrefix) ? entry.name.slice(basePrefix.length) : entry.name;
    if (!relName) continue;
    if (looksLikeTextFileName(relName)) {
      supportingFiles.push({ name: relName, content: await entry.async("string") });
    } else {
      const bytes = await entry.async("uint8array");
      supportingFiles.push({ name: relName, binary: true, size: bytes.length });
    }
  }

  return result.valid
    ? { valid: true, raw, parsed: result, supportingFiles }
    : { valid: false, raw, errors: result.errors, supportingFiles };
}

function makeEntryId() {
  return crypto.randomUUID ? crypto.randomUUID() : `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function SkillUploadPage({ onCancel, onUpload }) {
  const [entries, setEntries] = useState([]); // { id, fileName, valid, errors, parsed, raw, previewable, supportingFiles }
  const [dragOver, setDragOver] = useState(false);
  const [showExample, setShowExample] = useState(false);
  const [expandedEntry, setExpandedEntry] = useState(null); // entry id currently open for SKILL.md view/edit
  const [expandedSupportingKey, setExpandedSupportingKey] = useState(null); // "entryId::supportingFileName"
  const fileInputRef = useRef(null);

  // Entries are matched by a generated id, not by fileName — two uploaded
  // files can legitimately share a name (every skill's manifest is always
  // called SKILL.md), and matching by name would let edits/removals on one
  // entry silently affect another with the same filename.
  //
  // Placeholders go in immediately, in selection order; each is patched in
  // place once its (async) read/unzip resolves. Appending only on resolve
  // would let display order depend on which file happens to finish reading
  // first — for several small files dropped together, that's not
  // guaranteed to match the order they were dropped in.
  const addFiles = (fileList) => {
    const files = Array.from(fileList || []);
    const ids = files.map(() => makeEntryId());
    setEntries((prev) => [...prev, ...files.map((file, i) => ({ id: ids[i], fileName: file.name, loading: true }))]);

    files.forEach((file, i) => {
      const id = ids[i];
      const patch = (result) => setEntries((prev) => prev.map((e) => (e.id === id ? { id, fileName: file.name, ...result } : e)));

      if (/\.(zip|skill)$/i.test(file.name)) {
        unzipSkillPackage(file)
          .then((result) => patch({ previewable: !!result.raw, ...result }))
          .catch(() => patch({
            valid: false, previewable: false,
            errors: ["Couldn't open this package — it may be corrupted or not a valid .zip file."],
          }));
        return;
      }
      if (!/\.(md|markdown)$/i.test(file.name)) {
        patch({ valid: false, previewable: false, errors: ["Unsupported file type — upload a .md SKILL file, or a .zip/.skill package."] });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const raw = String(reader.result || "");
        const result = parseSkillMarkdown(raw);
        patch(result.valid
          ? { valid: true, previewable: true, parsed: result, raw }
          : { valid: false, previewable: true, errors: result.errors, raw });
      };
      reader.onerror = () => patch({ valid: false, previewable: false, errors: ["Couldn't read the file."] });
      reader.readAsText(file);
    });
  };

  const handlePicked = (e) => { addFiles(e.target.files); e.target.value = ""; };
  const handleDrop = (e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); };
  const removeEntry = (id) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    if (expandedEntry === id) setExpandedEntry(null);
  };

  // Editing the raw text re-validates live, so fixing a missing field (or
  // breaking one) updates the pass/fail state immediately — no re-upload
  // needed to correct a file caught by the scan below.
  const updateEntryContent = (id, raw) => {
    const result = parseSkillMarkdown(raw);
    setEntries((prev) => prev.map((e) => (e.id === id
      ? (result.valid ? { ...e, valid: true, parsed: result, errors: undefined, raw } : { ...e, valid: false, parsed: undefined, errors: result.errors, raw })
      : e)));
  };

  const updateSupportingFileContent = (id, supportingName, content) => {
    setEntries((prev) => prev.map((e) => (e.id === id
      ? { ...e, supportingFiles: e.supportingFiles.map((f) => (f.name === supportingName ? { ...f, content } : f)) }
      : e)));
  };

  const stillLoading = entries.some((e) => e.loading);
  const validEntries = entries.filter((e) => e.valid);
  const hasInvalid = entries.some((e) => !e.loading && !e.valid);
  const scanState = entries.length === 0 ? "idle" : stillLoading ? "scanning" : hasInvalid ? "failed" : "passed";

  return (
    <div className="flex flex-col h-full overflow-auto bg-white text-gray-800">
      <div className="px-6 pt-6 pb-4 border-b border-gray-100">
        <button onClick={onCancel} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 transition cursor-pointer mb-4">
          <ChevronLeft className="w-4 h-4" /> Back to Marketplace
        </button>
        <h1 className="text-xl font-bold text-gray-900">Upload a skill</h1>
        <p className="text-sm text-gray-500 mt-1">Add a skill to your workspace. A security scan runs when you upload.</p>
      </div>

      <div className="px-6 py-6 max-w-2xl space-y-4">
        <div>
          <label className="block text-sm font-semibold text-gray-800 mb-2">Skill file</label>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-10 px-4 text-center cursor-pointer transition ${
              dragOver ? "border-indigo-400 bg-indigo-50" : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
            }`}
          >
            <Upload className="w-6 h-6 text-gray-400" />
            <p className="text-sm text-gray-600">Drag and drop skill files here, or browse — you can add several at once</p>
            <input ref={fileInputRef} type="file" accept=".md,.markdown,.zip,.skill,text/markdown" multiple className="hidden" onChange={handlePicked} />
          </div>
          <ul className="mt-2 text-xs text-gray-500 list-disc list-inside space-y-0.5">
            <li>.md file must contain skill name and description formatted in YAML</li>
            <li>.zip or .skill file must include a SKILL.md file at its root (or one folder deep) — any other files in the package are bundled as supporting files, subfolders included</li>
          </ul>
          <button onClick={() => setShowExample((v) => !v)} className="mt-2 text-xs text-indigo-600 hover:text-indigo-800 transition cursor-pointer">
            {showExample ? "Hide" : "Show"} the expected SKILL.md format
          </button>
          {showExample && (
            <pre className="mt-2 p-3 bg-gray-50 border border-gray-100 rounded-lg text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap">{SKILL_MD_EXAMPLE}</pre>
          )}
        </div>

        {entries.length > 0 && (
          <div className="space-y-1.5">
            {entries.map((e) => {
              const expanded = expandedEntry === e.id;
              if (e.loading) {
                return (
                  <div key={e.id} className="rounded-lg border overflow-hidden bg-gray-50 border-gray-200">
                    <div className="flex items-start gap-2.5 p-2.5 text-sm">
                      <div className="w-4 h-4 flex-shrink-0 mt-0.5 rounded-full border-2 border-gray-300 border-t-indigo-500 animate-spin" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 font-medium text-gray-500">
                          <FileText className="w-3.5 h-3.5 text-gray-400" /> {e.fileName}
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5">Reading…</div>
                      </div>
                      <button onClick={() => removeEntry(e.id)} className="text-gray-400 hover:text-gray-600 cursor-pointer flex-shrink-0" title="Remove">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={e.id} className={`rounded-lg border overflow-hidden ${e.valid ? "bg-green-50 border-green-100" : "bg-red-50 border-red-200"}`}>
                  <div className="flex items-start gap-2.5 p-2.5 text-sm">
                    {e.valid ? <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" /> : <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />}
                    <div className="min-w-0 flex-1">
                      <button
                        onClick={() => e.previewable && setExpandedEntry(expanded ? null : e.id)}
                        disabled={!e.previewable}
                        className={`flex items-center gap-1.5 font-medium text-gray-800 ${e.previewable ? "hover:text-indigo-700 cursor-pointer" : "cursor-default"}`}
                      >
                        <FileText className="w-3.5 h-3.5 text-gray-400" /> {e.fileName}
                      </button>
                      {e.valid
                        ? <div className="text-xs text-green-700 mt-0.5">Parsed as "{e.parsed.name}" — ready to upload.</div>
                        : <ul className="text-xs text-red-700 mt-0.5 list-disc list-inside">{e.errors.map((err, i) => <li key={i}>{err}</li>)}</ul>}
                    </div>
                    {e.previewable && (
                      <button onClick={() => setExpandedEntry(expanded ? null : e.id)} title={expanded ? "Hide" : "View / edit"} className="text-gray-400 hover:text-indigo-600 cursor-pointer flex-shrink-0">
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button onClick={() => removeEntry(e.id)} className="text-gray-400 hover:text-gray-600 cursor-pointer flex-shrink-0" title="Remove">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {expanded && e.previewable && (
                    <textarea
                      value={e.raw}
                      onChange={(ev) => updateEntryContent(e.id, ev.target.value)}
                      rows={10}
                      spellCheck={false}
                      className="w-full px-3 py-2 text-xs font-mono text-gray-700 bg-white border-t border-gray-100 outline-none resize-none"
                    />
                  )}
                  {e.supportingFiles && e.supportingFiles.length > 0 && (
                    <div className="border-t border-gray-100 bg-white px-2.5 py-2 space-y-1.5">
                      <p className="text-xs text-gray-400">
                        {e.supportingFiles.length} supporting file{e.supportingFiles.length !== 1 ? "s" : ""} in this package:
                      </p>
                      {e.supportingFiles.map((f) => {
                        const key = `${e.id}::${f.name}`;
                        const fExpanded = expandedSupportingKey === key;
                        return (
                          <div key={f.name} className="border border-gray-100 rounded-lg overflow-hidden">
                            <div className="flex items-center gap-2 px-2 py-1.5 bg-gray-50">
                              <FileText className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                              <button
                                onClick={() => !f.binary && setExpandedSupportingKey(fExpanded ? null : key)}
                                disabled={f.binary}
                                className={`flex-1 text-left truncate text-xs ${f.binary ? "text-gray-500 cursor-default" : "text-gray-700 hover:text-indigo-700 cursor-pointer"}`}
                              >
                                {f.name}
                              </button>
                              {f.binary ? (
                                <span className="text-[10px] text-gray-400 flex-shrink-0">binary · preview not available yet</span>
                              ) : (
                                <button
                                  onClick={() => setExpandedSupportingKey(fExpanded ? null : key)}
                                  title={fExpanded ? "Hide" : "View / edit"}
                                  className="p-0.5 text-gray-400 hover:text-indigo-600 transition cursor-pointer flex-shrink-0"
                                >
                                  <Eye className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                            {fExpanded && !f.binary && (
                              <textarea
                                value={f.content}
                                onChange={(ev) => updateSupportingFileContent(e.id, f.name, ev.target.value)}
                                rows={6}
                                spellCheck={false}
                                className="w-full px-3 py-2 text-xs font-mono text-gray-700 bg-white border-t border-gray-100 outline-none resize-none"
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between px-4 py-3 border border-gray-200 rounded-xl">
          <span className="text-sm font-medium text-gray-800">Security scan</span>
          <span className={`text-xs font-medium ${scanState === "passed" ? "text-green-600" : scanState === "failed" ? "text-red-600" : "text-gray-400"}`}>
            {scanState === "idle" ? "Runs when you upload" : scanState === "scanning" ? "Reading files…" : scanState === "passed" ? "✓ Passed" : "Fix the files above to continue"}
          </span>
        </div>

        <div className="flex items-center gap-3 pb-6">
          <button
            onClick={() => onUpload(validEntries.map((e) => ({ ...e.parsed, files: e.supportingFiles || [] })))}
            disabled={validEntries.length === 0 || hasInvalid || stillLoading}
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Upload{validEntries.length > 0 ? ` ${validEntries.length} skill${validEntries.length !== 1 ? "s" : ""}` : ""}
          </button>
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 cursor-pointer">Cancel</button>
          {entries.length === 0 && <span className="text-xs text-gray-400">Choose a file to continue.</span>}
          {!stillLoading && hasInvalid && <span className="text-xs text-red-500">Remove or fix the failed file(s) above to continue.</span>}
        </div>
      </div>
    </div>
  );
}

// ── Create / Edit modal ───────────────────────────────────────────────────

function CreateItemModal({ tabKey, existing, allSkills, allConnectors, onClose, onSave }) {
  const tab = TABS.find((t) => t.key === tabKey);
  const kind = singular[tabKey];
  const [name, setName] = useState(existing?.name || "");
  const [description, setDescription] = useState(existing?.description || "");
  const [category, setCategory] = useState(existing?.category || tab.categories[0]);
  const [icon, setIcon] = useState(existing?.icon || tab.icons[0]);
  const [tags, setTags] = useState((existing?.tags || []).join(", "));
  const [instructions, setInstructions] = useState(existing?.instructions || "");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl || "");
  const [authType, setAuthType] = useState(existing?.authType || "api_key");
  const [skillIds, setSkillIds] = useState(existing?.skillIds || []);
  const [connectorIds, setConnectorIds] = useState(existing?.connectorIds || []);
  const [error, setError] = useState("");

  const toggleId = (list, setList, id) => setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const submit = () => {
    if (!name.trim() || !description.trim()) { setError("Name and description are required."); return; }
    const data = {
      name: name.trim(),
      description: description.trim(),
      category,
      icon,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      ...(kind === "skill" ? { instructions } : {}),
      ...(kind === "connector" ? { baseUrl, authType } : {}),
      ...(kind === "plugin" ? { skillIds, connectorIds } : {}),
    };
    onSave(data, existing);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-gray-900">{existing ? "Edit" : "Create"} a {kind}</h2>
          <button onClick={onClose} className="p-1 rounded text-gray-400 hover:text-gray-600 cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-xs text-gray-500 mb-4">Saved to your browser for now — this becomes a real API call once the backend for this feature exists.</p>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Icon</label>
            <div className="flex flex-wrap gap-1.5">
              {tab.icons.map((ic) => (
                <button key={ic} onClick={() => setIcon(ic)} className={`w-9 h-9 rounded-lg flex items-center justify-center text-lg border transition cursor-pointer ${icon === ic ? "border-indigo-400 bg-indigo-50" : "border-gray-200 hover:bg-gray-50"}`}>
                  {ic}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${kind === "skill" ? "Meeting Notes Summarizer" : kind === "connector" ? "Internal Wiki" : "Support Bundle"}`}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 transition" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder={`What does this ${kind} do?`}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 transition resize-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 transition bg-white">
                {tab.categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Tags (comma-separated)</label>
              <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="demo, internal"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 transition" />
            </div>
          </div>

          {kind === "skill" && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Instructions</label>
              <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} placeholder="What should the model do when this skill is used? Be specific about inputs and the expected output shape."
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 transition resize-none" />
            </div>
          )}

          {kind === "connector" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Base URL</label>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 transition" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Auth type</label>
                <select value={authType} onChange={(e) => setAuthType(e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 transition bg-white">
                  {["api_key", "oauth2", "bearer_token", "basic_auth", "none"].map((a) => <option key={a} value={a}>{a.replace(/_/g, " ")}</option>)}
                </select>
              </div>
            </div>
          )}

          {kind === "plugin" && (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Bundle skills</label>
                <div className="max-h-28 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {allSkills.length === 0 ? <p className="text-xs text-gray-400 px-3 py-2">No skills created yet.</p> : allSkills.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50">
                      <input type="checkbox" checked={skillIds.includes(s.id)} onChange={() => toggleId(skillIds, setSkillIds, s.id)} />
                      <span>{s.icon}</span> {s.name}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Bundle connectors</label>
                <div className="max-h-28 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {allConnectors.length === 0 ? <p className="text-xs text-gray-400 px-3 py-2">No connectors created yet.</p> : allConnectors.map((c) => (
                    <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50">
                      <input type="checkbox" checked={connectorIds.includes(c.id)} onChange={() => toggleId(connectorIds, setConnectorIds, c.id)} />
                      <span>{c.icon}</span> {c.name}
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {error && <div className="mt-3 p-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg">{error}</div>}

        <div className="flex gap-2 mt-5 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 cursor-pointer">Cancel</button>
          <button onClick={submit} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition cursor-pointer">
            {existing ? "Save changes" : `Create ${kind}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Third-party legal & compatibility check ─────────────────────────────
// Shown the first time you "use" a third-party skill (not on removal, and
// never for skills you created yourself). Reflects REAL data from the
// backend (routers/marketplace_skills_router.py's `license`/`securityStatus`
// fields, backed by services/marketplace_skill_ingestion.py's real license
// classification and services/skill_security_scan.py's real content scan) —
// this is no longer a static always-passing placeholder. Only shown for
// skills this router's `install` endpoint would actually allow; a skill
// whose scan resolved to "blocked" never reaches this modal in the first
// place (the "Use in chat" toggle itself is disabled for those, per
// SkillDetailPage/ItemCard).

function ThirdPartyCheckModal({ item, busy, onCancel, onAccept }) {
  // Four real states, not just yes/no:
  // - source === "internal" (the 6 demo seed skills — flagged thirdParty
  //   for this modal to have something to demo, but actually authored by
  //   AiNxt, not sourced from any external license at all) — always fine.
  // - a genuinely MIT-compatible license on file (green).
  // - a license IS on file but isn't one this project recognizes as
  //   compatible with its own MIT license (red — should be rare, since
  //   ingestion already filters these out before they ever reach the
  //   catalog, but the install endpoint re-checks this defensively too).
  // - no license on file at all for real external content (amber, blocks
  //   install — matches isSkillLicenseUsable()'s "missing counts as no").
  const isInternalSource = item.source === "internal";
  const licenseCompatible = isInternalSource || (!!item.license && MIT_COMPATIBLE_LICENSE_IDS.includes(item.license));
  const licenseIncompatibleOnFile = !isInternalSource && !!item.license && !licenseCompatible;
  const security = item.securityStatus || "unscanned";
  const securityMeta = {
    passed:    { tone: "green",  label: "No issues found", detail: "Our automated content scan found no prompt-injection, exfiltration, or destructive-action patterns in this skill's instructions." },
    caution:   { tone: "amber",  label: "Review flagged",  detail: "Our automated scan flagged something worth a second look — read the skill's full instructions (Contents tab) before relying on it." },
    blocked:   { tone: "red",    label: "Blocked",          detail: "This skill failed our automated security scan and cannot be used in chat." },
    unscanned: { tone: "gray",   label: "Not yet scanned",  detail: "This skill hasn't been through our automated security scan yet." },
  }[security] || { tone: "gray", label: security, detail: "" };
  const toneClasses = {
    green: "bg-green-50 border-green-100 text-green-600",
    amber: "bg-amber-50 border-amber-100 text-amber-600",
    red:   "bg-red-50 border-red-100 text-red-600",
    gray:  "bg-gray-50 border-gray-100 text-gray-500",
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-xl brand-grad-vivid flex items-center justify-center text-lg flex-shrink-0">{item.icon}</div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900">Legal &amp; compatibility check</h2>
            <p className="text-xs text-gray-500 truncate">{item.name} · by {item.author}</p>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-3 mb-4">
          {isInternalSource
            ? "This skill is published by AiNxt itself, not an outside vendor. Here's what we actually checked before letting you use it."
            : "This skill is published by a third party, not AiNxt. Here's what we actually checked before letting you use it."}
        </p>
        <div className="space-y-2 mb-3">
          <div className={`flex items-start gap-2.5 p-2.5 border rounded-lg ${toneClasses[licenseCompatible ? "green" : licenseIncompatibleOnFile ? "red" : "amber"]}`}>
            <Check className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-800">License</div>
              <div className="text-xs text-gray-500">
                {isInternalSource
                  ? "Published directly by AiNxt — no external license applies, same as anything else built into this platform."
                  : licenseCompatible
                  ? <>Sourced under <span className="font-medium">{item.license}</span>{item.source && item.source !== "internal" ? ` from ${item.source}` : ""} — permissively licensed and compatible with this project's MIT license.</>
                  : licenseIncompatibleOnFile
                  ? <>Licensed under <span className="font-medium">{item.license}</span> — this is <span className="font-medium">not compatible</span> with this project's MIT license and this skill cannot be used in chat.</>
                  : "No verified open-source license on file for this skill — treat its instructions as unreviewed third-party content."}
              </div>
            </div>
          </div>
          <div className={`flex items-start gap-2.5 p-2.5 border rounded-lg ${toneClasses[securityMeta.tone]}`}>
            <Check className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-800">Security scan: {securityMeta.label}</div>
              <div className="text-xs text-gray-500">{securityMeta.detail}</div>
            </div>
          </div>
        </div>
        <p className="text-xs text-gray-400 mb-5">
          These are automated checks, not a manual audit. We don't inspect what a skill's instructions ask the model to do
          beyond this scan — review the Contents tab yourself before relying on sensitive skills.
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} disabled={busy} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">Cancel</button>
          <button onClick={onAccept} disabled={!licenseCompatible || busy}
            title={!licenseCompatible ? "This skill has no verified license that's compatible with this project's MIT license — it can't be used in chat" : undefined}
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition cursor-pointer flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {busy ? "Enabling…" : "Accept & use"}
          </button>
        </div>
      </div>
    </div>
  );
}
