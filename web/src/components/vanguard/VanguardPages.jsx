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
import AssembliesPage from "./AssembliesPage.jsx";
import MaterialsPage from "./MaterialsPage.jsx";
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

function LoginPage({ onUser, emailEnabled }) {
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
      {emailEnabled
        ? <p className="vp-small"><Link to="/forgot">Forgot your password?</Link></p>
        : <p className="vp-muted vp-small">Forgot your password? Ask your admin for a reset link.</p>}
    </AuthCard>
  );
}

function ForgotPage() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const { busy, error, submit } = useSubmit(async () => {
    await api("POST", "/api/password/forgot", { json: { email } });
    setDone(true);
  });
  if (done) return (
    <AuthCard title="Check your email" subtitle={`If ${email} has an account, a link to choose a new password is on its way. It works for 1 hour.`}>
      <Link className="vp-btn" to="/">Back to sign in</Link>
    </AuthCard>
  );
  return (
    <AuthCard title="Reset your password" subtitle="Enter your email and we'll send you a link to choose a new password.">
      <form onSubmit={submit} className="vp-form">
        <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required />
        {error && <p className="vp-error">{error}</p>}
        <button className="vp-btn vp-primary" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
      </form>
      <p className="vp-small"><Link to="/">Back to sign in</Link></p>
    </AuthCard>
  );
}

function ResetPage({ onUser }) {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const [info, setInfo] = useState(null);
  const [loadErr, setLoadErr] = useState("");
  const [f, setF] = useState({ password: "", confirm: "" });
  const navigate = useNavigate();
  useEffect(() => { api("GET", `/api/password/reset/${enc(token)}`).then(setInfo, (e) => setLoadErr(e.message)); }, [token]);
  const { busy, error, submit } = useSubmit(async () => {
    if (f.password !== f.confirm) throw new Error("The two passwords don't match.");
    const r = await api("POST", `/api/password/reset/${enc(token)}`, { json: { password: f.password } });
    onUser(r.user);
    navigate("/", { replace: true });
  });
  if (loadErr) return <AuthCard title="Reset link not valid" subtitle={loadErr}><Link className="vp-btn" to="/forgot">Send a new link</Link></AuthCard>;
  if (!info) return <AuthCard title="Checking your link…" />;
  return (
    <AuthCard title="Choose a new password" subtitle={`For ${info.email}`}>
      <form onSubmit={submit} className="vp-form">
        <Field label="New password (8+ characters)" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" autoFocus required minLength={8} />
        <Field label="Confirm new password" type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" required />
        {error && <p className="vp-error">{error}</p>}
        <button className="vp-btn vp-primary" disabled={busy}>{busy ? "Saving…" : "Save and sign in"}</button>
      </form>
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
        <Link to="/assemblies">Assemblies</Link>
        <Link to="/materials">Materials</Link>
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
function EmailSettings({ onChanged }) {
  const [cfg, setCfg] = useState(null);
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);
  const load = useCallback(() => api("GET", "/api/settings/email").then((c) => {
    setCfg(c);
    setF({ smtp_host: c.smtp_host, smtp_port: c.smtp_port || "465", smtp_user: c.smtp_user, smtp_password: "", smtp_from: c.smtp_from, public_url: c.public_url || c.suggested_url });
    setOpen(!c.configured);
  }), []);
  useEffect(() => { load(); }, [load]);
  const save = useSubmit(async () => {
    setMsg("");
    const r = await api("PUT", "/api/settings/email", { json: f });
    await load(); onChanged?.();
    setMsg(r.configured ? "Saved. Send a test email to make sure it works." : "Saved, but the mail server, username and password are all needed.");
  });
  const test = useSubmit(async () => {
    setMsg("");
    const r = await api("POST", "/api/settings/email/test");
    setMsg(`Test email sent to ${r.to}. Check that inbox (and spam).`);
  });
  if (!cfg || !f) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="vp-panel">
      <div className="vp-panel-head">
        <h2>Email</h2>
        <span className={cfg.configured ? "vp-pill vp-pill-ok" : "vp-pill"}>{cfg.configured ? `On — sending from ${cfg.smtp_user}` : "Off — invites and resets are copy-and-send links"}</span>
        <button className="vp-btn vp-ghost" onClick={() => setOpen((v) => !v)}>{open ? "Hide settings" : "Settings"}</button>
      </div>
      {open && (
        <form className="vp-form vp-mailform" onSubmit={save.submit}>
          <p className="vp-muted vp-small">Use the same mailbox as the DrywallApp (for example noreply@vanguarddrywall.ca on mail.vanguarddrywall.ca). Port 465 uses SSL, 587 uses STARTTLS.</p>
          <div className="vp-mailgrid">
            <Field label="Mail server" value={f.smtp_host} onChange={set("smtp_host")} placeholder="mail.vanguarddrywall.ca" />
            <Field label="Port" value={f.smtp_port} onChange={set("smtp_port")} placeholder="465" inputMode="numeric" />
            <Field label="Username (mailbox)" value={f.smtp_user} onChange={set("smtp_user")} placeholder="noreply@vanguarddrywall.ca" autoComplete="off" />
            <Field label={cfg.has_password ? "Password (leave blank to keep)" : "Password"} type="password" value={f.smtp_password} onChange={set("smtp_password")} autoComplete="new-password" />
            <Field label="From name and address" value={f.smtp_from} onChange={set("smtp_from")} placeholder="Vanguard Takeoff <noreply@vanguarddrywall.ca>" />
            <Field label="Link address in emails" value={f.public_url} onChange={set("public_url")} placeholder="https://takeoff.vanguarddrywall.ca" />
          </div>
          {(save.error || test.error) && <p className="vp-error">{save.error || test.error}</p>}
          {msg && <p className="vp-ok">{msg}</p>}
          <div className="vp-row">
            <button type="button" className="vp-btn" disabled={test.busy || !cfg.configured} onClick={test.submit}>{test.busy ? "Sending…" : "Send test email"}</button>
            <button className="vp-btn vp-primary" disabled={save.busy}>Save</button>
          </div>
        </form>
      )}
    </section>
  );
}

function TeamPage({ user, emailEnabled, onEmailChanged }) {
  const [users, setUsers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [link, setLink] = useState(null);
  const [copied, setCopied] = useState(false);
  const [sendEmail, setSendEmail] = useState(true);
  const [resetInfo, setResetInfo] = useState(null);   // { name, url, emailed, email_error }
  const load = useCallback(() => Promise.all([api("GET", "/api/users"), api("GET", "/api/invites")])
    .then(([u, i]) => { setUsers(u.users); setInvites(i.invites); }, (e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const invite = useSubmit(async () => {
    const r = await api("POST", "/api/invites", { json: { email: email.trim(), role, send_email: emailEnabled && sendEmail } });
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
          <button className="vp-btn vp-primary" disabled={invite.busy}>{emailEnabled && sendEmail ? "Send invite" : "Create invite link"}</button>
        </form>
        {emailEnabled && <label className="vp-check"><input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} /> Email the invite for me</label>}
        {invite.error && <p className="vp-error">{invite.error}</p>}
        {link && (
          <div className="vp-linkbox">
            {link.emailed
              ? <p><strong>Invite emailed to {link.email}.</strong> The link works once and expires in {link.expires_days} days. A copy, in case it lands in spam:</p>
              : <p>{link.email_error && <span className="vp-error-inline">{link.email_error} </span>}<strong>Send this link to {link.email}.</strong> It works once and expires in {link.expires_days} days.</p>}
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
              <td className="vp-right">{u.id !== user.id && u.active && (
                <button className="vp-btn vp-ghost" onClick={async () => {
                  try { const r = await api("POST", `/api/users/${u.id}/reset`); setResetInfo({ name: u.name, email: u.email, ...r }); }
                  catch (e) { setError(e.message); }
                }}>{emailEnabled ? "Send password reset" : "Password reset link"}</button>
              )}{u.id !== user.id && (u.active
                ? <button className="vp-btn vp-ghost vp-danger" onClick={() => patch(u, { active: false })}>Turn off access</button>
                : <button className="vp-btn vp-ghost" onClick={() => patch(u, { active: true })}>Turn access back on</button>)}</td>
            </tr>
          ))}
        </tbody></table>
        {resetInfo && (
          <div className="vp-linkbox">
            {resetInfo.emailed
              ? <p><strong>Reset link emailed to {resetInfo.email}.</strong> It works once, within 1 hour.</p>
              : <p>{resetInfo.email_error && <span className="vp-error-inline">{resetInfo.email_error} </span>}<strong>Send this link to {resetInfo.name}.</strong> It works once, within 1 hour.</p>}
            <div className="vp-row"><input readOnly value={resetInfo.url} onFocus={(e) => e.target.select()} aria-label="Reset link" />
              <button className="vp-btn" onClick={() => navigator.clipboard?.writeText(resetInfo.url)}>Copy link</button>
              <button className="vp-btn vp-ghost" onClick={() => setResetInfo(null)}>Done</button></div>
          </div>
        )}
      </section>

      <EmailSettings onChanged={onEmailChanged} />
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
  const [emailEnabled, setEmailEnabled] = useState(!!initial.email_enabled);
  const refreshStatus = () => api("GET", "/api/status").then((st) => setEmailEnabled(!!st.email_enabled), () => {});
  const navigate = useNavigate();
  useEffect(() => onSignedOut(() => setUser(null)), []);
  const onUser = (u) => { setUser(u); setSetupNeeded(false); };
  const signOut = async () => {
    try { await api("POST", "/api/logout"); } finally { setUser(null); navigate("/", { replace: true }); }
  };
  return (
    <Routes>
      <Route path="/invite" element={<InvitePage onUser={onUser} />} />
      <Route path="/reset" element={<ResetPage onUser={onUser} />} />
      {!user && <Route path="/forgot" element={<ForgotPage />} />}
      {!user ? (
        <Route path="*" element={setupNeeded ? <SetupPage onUser={onUser} /> : <LoginPage onUser={onUser} emailEnabled={emailEnabled} />} />
      ) : (<>
        <Route path="/project/:id" element={<ProjectCanvas />} />
        <Route path="/" element={<><TopBar user={user} onSignOut={signOut} /><ProjectsPage user={user} /></>} />
        <Route path="/assemblies" element={<><TopBar user={user} onSignOut={signOut} /><AssembliesPage /></>} />
        <Route path="/materials" element={<><TopBar user={user} onSignOut={signOut} /><MaterialsPage /></>} />
        <Route path="/team" element={user.role === "admin" ? <><TopBar user={user} onSignOut={signOut} /><TeamPage user={user} emailEnabled={emailEnabled} onEmailChanged={refreshStatus} /></> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </>)}
    </Routes>
  );
}
