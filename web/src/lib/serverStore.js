// Vanguard Takeoff — a project stored on the Vanguard server.
//
// Implements the same store interface as localStore (lib/store.js) so the
// canvas works unchanged: plans, takeoff data and revisions live in the
// project on the server; condition/material/stamp libraries are shared by
// the whole company. Snapshots stay in this browser, scoped to the project
// (the same choice the Google Drive store makes).
import { api, ApiError, enc } from "./vanguardApi.js";
import { localStore, emptyAnnotations } from "./store.js";
import { sanitizeTemplates } from "./templates.js";
import { sanitizeMaterialLibrary } from "./materials.js";
import { sanitizeStampLibrary } from "./stamps.js";

export function createServerStore(projectId, { projectName = "" } = {}) {
  const base = `/api/projects/${enc(projectId)}`;
  const scope = `srv:${projectId}`;
  let version = null;            // takeoff-data version this tab last read/wrote
  let meta = null;               // Map name → { hash, rev, size }
  let metaPromise = null;
  const bytes = new Map();       // name → Promise<ArrayBuffer>  (session cache)

  const loadMeta = (refresh = false) => {
    if (meta && !refresh) return Promise.resolve(meta);
    if (!metaPromise || refresh) {
      metaPromise = api("GET", `${base}/pdfs`).then((r) => {
        meta = new Map(r.pdfs.map((p) => [p.name, p]));
        return meta;
      }).finally(() => { metaPromise = null; });
    }
    return metaPromise;
  };

  // Library: shared company-wide on the server. The first time a library is
  // read and the server has none yet, this browser's own library seeds it.
  const library = (kind, sanitize, localLoad) => ({
    async load() {
      const r = await api("GET", `/api/library/${kind}`);
      if (r.value == null) return localLoad();
      return sanitize(r.value);
    },
    async save(value) { await api("PUT", `/api/library/${kind}`, { json: { value } }); },
  });
  const templates = library("templates", sanitizeTemplates, () => localStore.loadTemplates());
  const materials = library("materials", sanitizeMaterialLibrary, () => localStore.loadMaterialLibrary());
  const stamps = library("stamps", sanitizeStampLibrary, () => localStore.loadStampLibrary());

  return {
    kind: "server",
    projectId,

    // ── plans ──────────────────────────────────────────────────────────────
    async listSheets() {
      const m = await loadMeta(true);
      return [...m.keys()].map((name) => ({ name }));
    },
    async loadPdfData(name) {
      let p = bytes.get(name);
      if (!p) {
        p = api("GET", `${base}/pdfs/${enc(name)}`);
        bytes.set(name, p);
        p.catch(() => { if (bytes.get(name) === p) bytes.delete(name); });
      }
      const buf = await p;
      return new Uint8Array(buf.slice(0));   // fresh copy: pdf.js may detach what it's given
    },
    async addPdf(file) {
      const buf = await file.arrayBuffer();
      const out = await api("PUT", `${base}/pdfs/${enc(file.name)}`, { raw: buf });
      bytes.set(file.name, Promise.resolve(buf));
      if (meta) meta.set(file.name, { name: file.name, hash: out.hash, rev: out.rev, size: buf.byteLength });
      const { hash: _h, ...result } = out;
      return result;
    },
    async removePdf(name) {
      await api("DELETE", `${base}/pdfs/${enc(name)}`);
      bytes.delete(name);
      meta?.delete(name);
    },
    pdfHash(name) {
      return loadMeta().then((m) => m.get(name)?.hash || null, () => null);
    },
    async pdfHashIfKnown(name) {
      return meta?.get(name)?.hash || null;
    },
    async listPdfRevisions(name) {
      const [m, r] = await Promise.all([loadMeta(), api("GET", `${base}/pdfs/${enc(name)}/revs`)]);
      const cur = m.get(name);
      const list = r.revs.map((x) => ({ rev: x.rev, hash: x.hash, ts: Math.round(x.ts * 1000) }));
      if (cur) list.push({ rev: cur.rev, hash: cur.hash, ts: Math.round((cur.ts || 0) * 1000), current: true });
      return list.sort((a, b) => b.rev - a.rev);
    },
    async loadPdfRevisionData(name, rev) {
      const m = await loadMeta();
      if (m.get(name)?.rev === rev) return this.loadPdfData(name);
      return new Uint8Array(await api("GET", `${base}/pdfs/${enc(name)}/revs/${rev}`));
    },

    // ── takeoff data ───────────────────────────────────────────────────────
    async loadAnnotations() {
      const r = await api("GET", `${base}/annotations`);
      version = r.version;
      return r.payload || { ...emptyAnnotations(), project_name: r.name || projectName };
    },
    async saveAnnotations(payload) {
      try {
        const r = await api("PUT", `${base}/annotations`, { json: { version, payload } });
        version = r.version;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          throw new Error("Someone else saved this project since you opened it. Reload the page to get their changes (yours since then weren't saved).");
        }
        throw e;
      }
    },

    // ── company libraries ──────────────────────────────────────────────────
    loadTemplates: () => templates.load(),
    saveTemplates: (list) => templates.save(Array.isArray(list) ? list : []),
    loadMaterialLibrary: () => materials.load(),
    saveMaterialLibrary: (list) => materials.save(Array.isArray(list) ? list : []),
    loadStampLibrary: () => stamps.load(),
    saveStampLibrary: (lib) => stamps.save(sanitizeStampLibrary(lib)),

    // ── snapshots: this browser, scoped to the project ─────────────────────
    saveSnapshot: (label, payload) => localStore.saveSnapshot(label, payload, scope),
    putSnapshot: (record) => localStore.putSnapshot({ ...record, project: scope }),
    listSnapshots: () => localStore.listSnapshots(scope),
    getSnapshot: (id) => localStore.getSnapshot(id, scope),
    deleteSnapshot: (id) => localStore.deleteSnapshot(id),
  };
}
