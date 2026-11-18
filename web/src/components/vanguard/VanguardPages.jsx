// Vanguard Takeoff — accounts and projects screens (server mode).
//
//   /            Projects: every company project, newest first; create, open,
//                rename, delete (creator or admin)
//   /project/:id The takeoff canvas on that project (server-stored)
//   /team        Admin only: invite people, see who has access, turn
//                accounts off, make someone an admin
//   /invite      Accept an invite link (public)
// First visit with no accounts → one-time admin setup.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams, Link } from "react-router";
import TakeoffCanvas from "../../pages/TakeoffCanvas.jsx";
import { setActiveStore } from "../../lib/store.js";
import { createServerStore } from "../../lib/serverStore.js";
import { api, enc, onSignedOut } from "../../lib/vanguardApi.js";
import "../../styles/vanguardPages.css";

// ── shared bits ─────────────────────────────────────────────────────────────
function Logo({ wide = false }) {
  return wide
    ? <img className="vp-logo-wide" src="/brand/wordmark.png" alt="Vanguard Drywall & Acoustics" onError={(e) => { e.currentTarget.style.display = "none"; }} />
    : <img className="vp-logo" src="/brand/logo.png" alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} />;
}

function AuthCard({ title, subtitle, children }) {
  return (
    <div className="vp-auth">
      <div className="vp-auth-card">
        <Logo wide />
        <h1>{title}</h1>
        {subtitle && <p className="vp-muted">{subtitle}</p>}
        {children}
      </div>
      <p className="vp-auth-foot">Vanguard Takeoff</p>
    </div>
  );
}

function Field({ label, ...props }) {
  return (
    <label className="vp-field">
      <span>{label}</span>
      <input {...props} />
    </label>
  );
}

function useSubmit(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); } catch (err) { setError(err?.message || String(err)); } finally { setBusy(false); }
  };
  return { busy, error, submit, setError };
}

const when = (ts) => {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return `today ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  if (days < 2) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString();
};

// ── auth screens ────────────────────────────────────────────────────────────
function SetupPage({ onUser }) {
  const [f, setF] = useState({ name: "", email: "", password: "", confirm: "" });
  const { busy, error, submit } = useSubmit(async () => {
    if (f.password !== f.confirm) throw new Error("The two passwords don't match.");
    const r = await api("POST", "/api/setup", { json: { name: f.name, email: f.email, password: f.password } });
    onUser(r.user);
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <AuthCard title="Welcome to Vanguard Takeoff" subtitle="Create the admin account. You'll be able to invite your team next.">
      <form onSubmit={submit} className="vp-form">
        <Field label="Your name" value={f.name} onChange={set("name")} autoComplete="name" autoFocus required />
        <Field label="Email" type="email" value={f.email} onChange={set("email")} autoComplete="email" required />
        <Field label="Password (8+ characters)" type="password" value={f.password} onChange={set("password")} autoComplete="new-password" required minLength={8} />
        <Field label="Confirm password" type="password" value={f.confirm} onChange={set("confirm")} autoComplete="new-password" required />
        {error && <p className="vp-error">{error}</p>}
        <button className="vp-btn vp-primary" disabled={busy}>{busy ? "Creating…" : "Create admin account"}</button>
      </form>
    </AuthCard>
  );
}

function LoginPage({ onUser }) {
  const [f, setF] = useState({ email: "", password: "" });
  const { busy, error, submit } = useSubmit(async () => {
    const r = await api("POST", "/api/login", { json: f });
    onUser(r.user);
  });
  return (
    <AuthCard title="Sign in" subtitle="Use the email your admin invited.">
      <form onSubmit={submit} className="vp-form">
        <Field label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" autoFocus required />
        <Field label="Password" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="current-password" required />
        {error && <p className="vp-error">{error}</p>}
        <button className="vp-btn vp-primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="vp-muted vp-small">Forgot your password? Ask your admin to send you a new invite.</p>
    </AuthCard>
  );
}

function InvitePage({ onUser }) {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const [invite, setInvite] = useState(null);
  const [loadErr, setLoadErr] = useState("");
  const [f, setF] = useState({ name: "", password: "", confirm: "" });
  const navigate = useNavigate();
  useEffect(() => {
    api("GET", `/api/invites/${enc(token)}`).then(setInvite, (e) => setLoadErr(e.message));
  }, [token]);
  const { busy, error, submit } = useSubmit(async () => {
    if (f.password !== f.confirm) throw new Error("The two passwords don't match.");
    const r = await api("POST", `/api/invites/${enc(token)}/accept`, { json: { name: f.name, password: f.password } });
    onUser(r.user);
    navigate("/", { replace: true });
  });
  if (loadErr) return <AuthCard title="Invite link not valid" subtitle={loadErr}><Link className="vp-btn" to="/">Go to sign in</Link></AuthCard>;
  if (!invite) return <AuthCard title="Checking your invite…" />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <AuthCard title="You're invited" subtitle={`Set up your account for ${invite.email}.`}>
      <form onSubmit={submit} className="vp-form">
        <Field label="Your name" value={f.name} onChange={set("name")} autoComplete="name" autoFocus required />
        <Field label="Choose a password (8+ characters)" type="password" value={f.password} onChange={set("password")} autoComplete="new-password" required minLength={8} />
        <Field label="Confirm password" type="password" value={f.confirm} onChange={set("confirm")} autoComplete="new-password" required />
        {error && <p className="vp-error">{error}</p>}
        <button className="vp-btn vp-primary" disabled={busy}>{busy ? "Setting up…" : "Create my account"}</button>
      </form>
    </AuthCard>
  );
}

// ── app frame (projects + team) ─────────────────────────────────────────────
function TopBar({ user, onSignOut }) {
  const [menu, setMenu] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  return (
    <header className="vp-top">
      <Link to="/" className="vp-brand"><Logo /><strong>Vanguard</strong><em>Takeoff</em></Link>
      <nav className="vp-nav">
        <Link to="/">Projects</Link>
        {user.role === "admin" && <Link to="/team">Team</Link>}
      </nav>
      <div className="vp-user">
        <button className="vp-btn vp-ghost" onClick={() => setMenu((v) => !v)} aria-expanded={menu}>
          <span className="vp-avatar">{(user.name || "?").slice(0, 1).toUpperCase()}</span>{user.name}
        </button>
        {menu && (
          <div className="vp-menu" onMouseLeave={() => setMenu(false)}>
            <div className="vp-menu-head"><strong>{user.name}</strong><span>{user.email}</span><span>{user.role === "admin" ? "Admin" : "Team member"}</span></div>
            <button onClick={() => { setMenu(false); setPwOpen(true); }}>Change password</button>
            <button onClick={onSignOut}>Sign out</button>
          </div>
        )}
      </div>
      {pwOpen && <PasswordDialog onClose={() => setPwOpen(false)} />}
    </header>
  );
}

function Dialog({ title, onClose, children }) {
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="vp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="vp-dialog" role="dialog" aria-label={title}>
        <header><h2>{title}</h2><button className="vp-x" onClick={onClose} aria-label="Close">×</button></header>
        {children}
      </div>
    </div>
  );
}

function PasswordDialog({ onClose }) {
  const [f, setF] = useState({ current: "", next: "", confirm: "" });
  const [done, setDone] = useState(false);
  const { busy, error, submit } = useSubmit(async () => {
    if (f.next !== f.confirm) throw new Error("The new passwords don't match.");
    await api("POST", "/api/account/password", { json: { current: f.current, new: f.next } });
    setDone(true);
  });
  return (
    <Dialog title="Change password" onClose={onClose}>
      {done ? <><p>Your password was changed.</p><button className="vp-btn vp-primary" onClick={onClose}>Done</button></> : (
        <form onSubmit={submit} className="vp-form">
          <Field label="Current password" type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoComplete="current-password" required autoFocus />
          <Field label="New password (8+ characters)" type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" required minLength={8} />
          <Field label="Confirm new password" type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" required />
          {error && <p className="vp-error">{error}</p>}
          <button className="vp-btn vp-primary" disabled={busy}>Change password</button>
        </form>
      )}
    </Dialog>
  );
}

// ── projects ────────────────────────────────────────────────────────────────
function ProjectsPage({ user }) {
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const navigate = useNavigate();
  const load = useCallback(() => api("GET", "/api/projects").then((r) => setProjects(r.projects), (e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const shown = useMemo(() => (projects || []).filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase())), [projects, query]);
  const mine = shown.filter((p) => p.created_by === user.id).length;

  return (
    <main className="vp-page">
      <div className="vp-page-head">
        <div>
          <h1>Projects</h1>
          <p className="vp-muted">{projects ? `${projects.length} project${projects.length === 1 ? "" : "s"} · ${mine} started by you` : "Loading…"}</p>
        </div>
        <button className="vp-btn vp-primary vp-big" onClick={() => setCreating(true)}>+ New project</button>
      </div>
      {error && <p className="vp-error">{error}</p>}
      {projects && projects.length > 0 && (
        <input className="vp-search" placeholder="Search projects…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search projects" />
      )}
      {projects && projects.length === 0 && (
        <div className="vp-empty">
          <h2>No projects yet</h2>
          <p className="vp-muted">Create a project, then open your plan set. Everything you measure is saved on the server automatically.</p>
          <button className="vp-btn vp-primary vp-big" onClick={() => setCreating(true)}>+ Create your first project</button>
        </div>
      )}
      <div className="vp-grid">
        {shown.map((p) => (
          <article key={p.id} className="vp-card" onClick={() => navigate(`/project/${p.id}`)} tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter") navigate(`/project/${p.id}`); }}>
            <div className="vp-card-icon" aria-hidden>▦</div>
            <h3 title={p.name}>{p.name}</h3>
            <p className="vp-muted vp-small">{p.plans} plan file{p.plans === 1 ? "" : "s"} · updated {when(p.updated_at)}</p>
            <p className="vp-muted vp-small">Started by {p.created_by === user.id ? "you" : p.creator || "—"}</p>
            <div className="vp-card-actions" onClick={(e) => e.stopPropagation()}>
              <button className="vp-btn vp-primary" onClick={() => navigate(`/project/${p.id}`)}>Open</button>
              <button className="vp-btn vp-ghost" onClick={() => setRenaming(p)}>Rename</button>
              {p.can_delete && <button className="vp-btn vp-ghost vp-danger" onClick={() => setDeleting(p)}>Delete</button>}
            </div>
          </article>
        ))}
      </div>
      {creating && <NameDialog title="New project" label="Project name" placeholder="e.g. Boss — Outlet Collection at Niagara" cta="Create project"
        onClose={() => setCreating(false)}
        onSave={async (name) => { const r = await api("POST", "/api/projects", { json: { name } }); navigate(`/project/${r.id}`); }} />}
      {renaming && <NameDialog title="Rename project" label="Project name" initial={renaming.name} cta="Save"
        onClose={() => setRenaming(null)}
        onSave={async (name) => { await api("PATCH", `/api/projects/${renaming.id}`, { json: { name } }); setRenaming(null); load(); }} />}
      {deleting && <ConfirmDialog title="Delete project?" cta="Delete project"
        body={<>“{deleting.name}” will disappear for everyone. An admin can still recover it from the server's database if it was a mistake.</>}
        onClose={() => setDeleting(null)}
        onConfirm={async () => { await api("DELETE", `/api/projects/${deleting.id}`); setDeleting(null); load(); }} />}
    </main>
  );
}

function NameDialog({ title, label, initial = "", placeholder, cta, onSave, onClose }) {
  const [name, setName] = useState(initial);
  const { busy, error, submit } = useSubmit(() => onSave(name.trim()));
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={submit} className="vp-form">
        <Field label={label} value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} autoFocus required maxLength={120} />
        {error && <p className="vp-error">{error}</p>}
        <div className="vp-row"><button type="button" className="vp-btn vp-ghost" onClick={onClose}>Cancel</button><button className="vp-btn vp-primary" disabled={busy || !name.trim()}>{cta}</button></div>
      </form>
    </Dialog>
  );
}

function ConfirmDialog({ title, body, cta, onConfirm, onClose }) {
  const { busy, error, submit } = useSubmit(onConfirm);
  return (
    <Dialog title={title} onClose={onClose}>
      <p>{body}</p>
      {error && <p className="vp-error">{error}</p>}
      <div className="vp-row"><button className="vp-btn vp-ghost" onClick={onClose}>Cancel</button><button className="vp-btn vp-primary vp-danger-fill" disabled={busy} onClick={submit}>{cta}</button></div>
    </Dialog>
  );
}

// ── team (admin) ────────────────────────────────────────────────────────────
function TeamPage({ user }) {
  const [users, setUsers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [link, setLink] = useState(null);
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => Promise.all([api("GET", "/api/users"), api("GET", "/api/invites")])
    .then(([u, i]) => { setUsers(u.users); setInvites(i.invites); }, (e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const invite = useSubmit(async () => {
    const r = await api("POST", "/api/invites", { json: { email: email.trim(), role } });
    setLink({ ...r, url: `${window.location.origin}${r.path}` });
    setCopied(false); setEmail(""); setRole("user"); load();
  });
  const patch = async (u, body) => {
    setError("");
    try { await api("PATCH", `/api/users/${u.id}`, { json: body }); load(); } catch (e) { setError(e.message); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(link.url); setCopied(true); } catch { setCopied(false); } };
  const mail = link && `mailto:${enc(link.email)}?subject=${enc("Your Vanguard Takeoff invite")}&body=${enc(`Hi,\n\nYou've been invited to Vanguard Takeoff. Open this link to set up your account (it works once and expires in ${link.expires_days} days):\n\n${link.url}\n\n${user.name}`)}`;

  return (
    <main className="vp-page vp-narrow">
      <div className="vp-page-head"><div><h1>Team</h1><p className="vp-muted">Invite people and manage who can use Vanguard Takeoff.</p></div></div>
      {error && <p className="vp-error">{error}</p>}

      <section className="vp-panel">
        <h2>Invite someone</h2>
        <form className="vp-invite" onSubmit={invite.submit}>
          <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@vanguarddrywall.ca" required />
          <label className="vp-field"><span>Access</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="user">Team member — takeoffs and projects</option>
              <option value="admin">Admin — also manages the team</option>
            </select>
          </label>
          <button className="vp-btn vp-primary" disabled={invite.busy}>Create invite link</button>
        </form>
        {invite.error && <p className="vp-error">{invite.error}</p>}
        {link && (
          <div className="vp-linkbox">
            <p><strong>Send this link to {link.email}.</strong> It works once and expires in {link.expires_days} days.</p>
            <div className="vp-row"><input readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Invite link" />
              <button className="vp-btn" onClick={copy}>{copied ? "Copied ✓" : "Copy link"}</button>
              <a className="vp-btn" href={mail}>Email it</a></div>
          </div>
        )}
      </section>

      {invites.length > 0 && (
        <section className="vp-panel">
          <h2>Waiting to join</h2>
          <table className="vp-table"><tbody>
            {invites.map((i) => (
              <tr key={i.id}><td>{i.email}</td><td>{i.role === "admin" ? "Admin" : "Team member"}</td><td className="vp-muted">expires {new Date(i.expires_at * 1000).toLocaleDateString()}</td>
                <td className="vp-right"><button className="vp-btn vp-ghost vp-danger" onClick={async () => { await api("DELETE", `/api/invites/${i.id}`); load(); }}>Cancel invite</button></td></tr>
            ))}
          </tbody></table>
        </section>
      )}

      <section className="vp-panel">
        <h2>People with access</h2>
        <table className="vp-table"><tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.active ? "" : "vp-off"}>
              <td><strong>{u.name}</strong>{u.id === user.id && <span className="vp-tag">you</span>}<div className="vp-muted vp-small">{u.email}</div></td>
              <td>
                <select value={u.role} disabled={u.id === user.id} onChange={(e) => patch(u, { role: e.target.value })} aria-label={`Access for ${u.name}`}>
                  <option value="user">Team member</option><option value="admin">Admin</option>
                </select>
              </td>
              <td className="vp-right">{u.id !== user.id && (u.active
                ? <button className="vp-btn vp-ghost vp-danger" onClick={() => patch(u, { active: false })}>Turn off access</button>
                : <button className="vp-btn vp-ghost" onClick={() => patch(u, { active: true })}>Turn access back on</button>)}</td>
            </tr>
          ))}
        </tbody></table>
      </section>
    </main>
  );
}

// ── a project in the canvas ────────────────────────────────────────────────
function ProjectCanvas() {
  const { id } = useParams();
  const [state, setState] = useState({ ready: false, error: "" });
  useEffect(() => {
    let live = true;
    setState({ ready: false, error: "" });
    api("GET", `/api/projects/${enc(id)}`).then((p) => {
      if (!live) return;
      setActiveStore(createServerStore(p.id, { projectName: p.name }));
      document.title = `${p.name} — Vanguard Takeoff`;
      setState({ ready: true, error: "" });
    }, (e) => { if (live) setState({ ready: false, error: e.message }); });
    return () => { live = false; setActiveStore(); document.title = "Vanguard Takeoff"; };
  }, [id]);
  if (state.error) return <AuthCard title="Couldn't open this project" subtitle={state.error}><Link className="vp-btn vp-primary" to="/">Back to projects</Link></AuthCard>;
  if (!state.ready) return <div className="vp-loading">Opening project…</div>;
  return <TakeoffCanvas key={id} />;
}

// ── root ────────────────────────────────────────────────────────────────────
export default function ServerRoot({ initial }) {
  const [user, setUser] = useState(initial.user);
  const [setupNeeded, setSetupNeeded] = useState(initial.setup_needed);
  const navigate = useNavigate();
  useEffect(() => onSignedOut(() => setUser(null)), []);
  const onUser = (u) => { setUser(u); setSetupNeeded(false); };
  const signOut = async () => {
    try { await api("POST", "/api/logout"); } finally { setUser(null); navigate("/", { replace: true }); }
  };
  return (
    <Routes>
      <Route path="/invite" element={<InvitePage onUser={onUser} />} />
      {!user ? (
        <Route path="*" element={setupNeeded ? <SetupPage onUser={onUser} /> : <LoginPage onUser={onUser} />} />
      ) : (<>
        <Route path="/project/:id" element={<ProjectCanvas />} />
        <Route path="/" element={<><TopBar user={user} onSignOut={signOut} /><ProjectsPage user={user} /></>} />
        <Route path="/team" element={user.role === "admin" ? <><TopBar user={user} onSignOut={signOut} /><TeamPage user={user} /></> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </>)}
    </Routes>
  );
}
