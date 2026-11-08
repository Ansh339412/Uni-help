import { useEffect, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { QRCodeSVG } from "qrcode.react";
import { api, supabase } from "./api";

type Item = { id: string; title: string; description: string; category: string; owner_name: string; owner_id: string; image_url?: string; location?: string; owner_rating?: string };
type Rq = { id: string; status: string; title: string; start: string; end: string; mine: boolean; handover_pin?: string; return_pin?: string };
const CATS = ["Electronics", "Books", "Lab tools", "Chargers", "Other"];
const btn = "rounded-md bg-forest px-4 py-2 text-sm font-medium text-ivory hover:bg-moss";
const fmt = (d: string) => new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export default function App() {
  const [session, setSession] = useState<any>(null);
  const [tab, setTab] = useState<"browse" | "requests" | "need" | "list" | "admin">("browse");
  const [stats, setStats] = useState<any>(null);
  const [admin, setAdmin] = useState(false);
  const rename = async () => {
    const name = prompt("Display name shown to other students");
    if (name?.trim()) await api("/api/me", { method: "PATCH", body: { name } }).catch(() => {});
  };
  const [toast, setToast] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!session) return;
    const ch = supabase.channel("my-notifications")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${session.user.id}` },
        (p) => { setToast((p.new as any).body); setTick((t) => t + 1); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session]);
  useEffect(() => { if (session) api("/api/admin/overview").then(() => setAdmin(true)).catch(() => setAdmin(false)); }, [session]);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    api("/api/stats").then(setStats).catch(() => {});
    return () => data.subscription.unsubscribe();
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-5 pb-24">
      {toast && (
        <div role="status" className="fixed bottom-5 right-5 z-10 rounded-md bg-forest px-4 py-3 text-sm text-ivory shadow-lg">
          {toast}<button className="ml-3 underline" onClick={() => setToast("")}>Dismiss</button>
        </div>
      )}
      <header className="flex items-center justify-between py-6">
        <span className="font-display text-2xl font-semibold">Circlend</span>
        {session && <div className="flex gap-4 text-sm text-fog"><button className="underline" onClick={rename}>Your name</button><button className="underline" onClick={() => supabase.auth.signOut()}>Sign out</button></div>}
      </header>
      <section className="py-10 sm:py-16">
        <h1 className="font-display text-5xl leading-[1.05] sm:text-7xl max-w-3xl">Why buy something you’ll only need for a day?</h1>
        <p className="mt-5 max-w-xl text-lg text-fog">Borrow calculators, books and chargers from students on your campus, and lend what you’re not using.</p>
        {stats && (
          <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-3 text-sm">
            <Stat n={stats.items_shared} l="items shared" />
            <Stat n={stats.successful_returns} l="successful returns" />
            <Stat n={stats.active_requests} l="active requests" />
            <Stat n={stats.estimated_purchases_avoided} l="purchases avoided (estimate)" />
          </dl>
        )}
      </section>
      {!session ? <Auth /> : (
        <>
          <nav className="mb-6 flex gap-2 border-b border-line">
            {([["browse", "Find items"], ["requests", "My requests"], ["need", "Need it now"], ["list", "List an item"], ...(admin ? [["admin", "Admin"] as const] : [])] as const).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 text-sm ${tab === k ? "border-b-2 border-forest font-semibold" : "text-fog"}`}>{label}</button>
            ))}
          </nav>
          {tab === "browse" && <Browse me={session.user.id} />}
          {tab === "requests" && <Requests tick={tick} />}
          {tab === "need" && <Need />}
          {tab === "admin" && <Admin />}
          {tab === "list" && <NewItem done={() => setTab("browse")} />}
        </>
      )}
    </div>
  );
}

const Stat = ({ n, l }: { n: number; l: string }) => (
  <div className="flex items-baseline gap-2"><dd className="font-display text-3xl">{n}</dd><dt className="text-fog">{l}</dt></div>
);

function Auth() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const go = async (signUp: boolean) => {
    const { error } = signUp ? await supabase.auth.signUp({ email, password }) : await supabase.auth.signInWithPassword({ email, password });
    setMsg(error ? error.message : signUp ? "Check your email to confirm your account." : "");
  };
  return (
    <div className="max-w-sm space-y-3">
      <input type="email" placeholder="University email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <div className="flex gap-2"><button className={btn} onClick={() => go(false)}>Sign in</button><button className="rounded-md border border-line px-4 py-2 text-sm" onClick={() => go(true)}>Create account</button></div>
      {msg && <p className="text-sm text-fog" role="status">{msg}</p>}
    </div>
  );
}

function Browse({ me }: { me: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cal, setCal] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const load = () => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (cat) p.set("category", cat);
    if (from && to) { p.set("from", new Date(from).toISOString()); p.set("to", new Date(to).toISOString()); }
    api<Item[]>(`/api/items?${p}`).then(setItems).catch((e) => setMsg(e.message));
  };
  useEffect(load, []);
  const request = async (id: string) => {
    if (!from || !to) return setMsg("Choose when you need it first.");
    try {
      await api("/api/requests", { method: "POST", body: { itemId: id, start: new Date(from).toISOString(), end: new Date(to).toISOString() } });
      setMsg("Request sent. The owner will confirm it.");
    } catch (e: any) { setMsg(e.message); }
  };
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-5">
        <input className="sm:col-span-2" placeholder="Search items" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
        <input type="datetime-local" aria-label="Needed from" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="datetime-local" aria-label="Needed until" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <button className={`${btn} mt-3`} onClick={load}>Show available items</button>
      {msg && <p className="mt-3 text-sm" role="status">{msg}</p>}
      <ul className="mt-6 grid gap-4 sm:grid-cols-2">
        {items.map((i) => (
          <li key={i.id} className="rounded-lg border border-line bg-paper p-5">
            {i.image_url && <img src={i.image_url} alt="" className="mb-3 aspect-[4/3] w-full rounded-md object-cover" />}
            <p className="text-sm text-fog">{i.category} · from {i.owner_name}{i.location ? ` at ${i.location}` : ""}{i.owner_rating ? ` · rated ${i.owner_rating}/5` : ""}</p>
            <h2 className="font-display text-2xl">{i.title}</h2>
            <p className="mt-1 text-sm">{i.description}</p>
            {i.owner_id === me
              ? <button className="mt-4 text-sm underline" onClick={() => api(`/api/items/${i.id}`, { method: "DELETE" }).then(load)}>Remove listing</button>
              : <button className={`${btn} mt-4`} onClick={() => request(i.id)}>Request to borrow</button>}
            {i.owner_id === me && <button className="ml-4 mt-4 text-sm underline" onClick={() => setCal(cal === i.id ? null : i.id)}>Set availability</button>}
            {cal === i.id && <Availability id={i.id} />}
          </li>
        ))}
        {!items.length && <p className="text-fog">Nothing matches yet. Try a wider window or list something yourself.</p>}
      </ul>
    </div>
  );
}

function Requests({ tick }: { tick: number }) {
  const [rows, setRows] = useState<Rq[]>([]);
  const [msg, setMsg] = useState("");
  const [chat, setChat] = useState<string | null>(null);
  useEffect(() => { if (tick) load(); }, [tick]);
  const [scan, setScan] = useState<{ id: string; action: string } | null>(null);
  const review = async (id: string) => {
    const rating = Number(prompt("Rate this loan from 1 to 5"));
    if (!rating) return;
    try { await api(`/api/requests/${id}/review`, { method: "POST", body: { rating } }); setMsg("Thanks for the review."); } catch (e: any) { setMsg(e.message); }
  };
  const load = () => api<Rq[]>("/api/requests").then(setRows).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);
  const act = async (id: string, action: string, needPin = false, given?: string) => {
    const pin = given ?? (needPin ? prompt("Enter the 6-digit PIN shown to the borrower") ?? undefined : undefined);
    if (needPin && !pin) return;
    try { await api(`/api/requests/${id}/${action}`, { method: "POST", body: { pin } }); setMsg(""); load(); } catch (e: any) { setMsg(e.message); }
  };
  return (
    <div className="space-y-3">
      {msg && <p className="text-sm" role="alert">{msg}</p>}
      {scan && <Scanner onClose={() => setScan(null)} onPin={(pin) => { const s = scan; setScan(null); act(s.id, s.action, true, pin); }} onManual={() => { const s = scan; setScan(null); act(s.id, s.action, true); }} />}
      {rows.map((r) => (
        <div key={r.id} className="rounded-lg border border-line bg-paper p-4">
          <p className="font-display text-xl">{r.title}</p>
          <p className="text-sm text-fog">{r.mine ? "You’re borrowing" : "Someone wants to borrow"} · {fmt(r.start)} to {fmt(r.end)} · {r.status.replace("_", " ")}</p>
          {r.mine && r.status === "confirmed" && <p className="mt-2 text-sm">Handover PIN: <b className="tracking-widest">{r.handover_pin}</b>. Give it to the owner when you collect.<QRCodeSVG value={r.handover_pin!} size={72} className="mt-2" /></p>}
          {r.mine && r.status === "handed_over" && <p className="mt-2 text-sm">Return PIN: <b className="tracking-widest">{r.return_pin}</b>. Give it to the owner when you return it.<QRCodeSVG value={r.return_pin!} size={72} className="mt-2" /></p>}
          {r.status === "returned" && <button className="mr-4 mt-2 text-sm underline" onClick={() => review(r.id)}>Rate this loan</button>}
          {["pending", "confirmed"].includes(r.status) && <button className="mr-4 mt-2 text-sm underline" onClick={() => act(r.id, "cancel")}>Cancel</button>}
          {r.status !== "declined" && <button className="mt-2 text-sm underline" onClick={() => setChat(chat === r.id ? null : r.id)}>{chat === r.id ? "Hide messages" : "Messages"}</button>}
          {chat === r.id && <Chat id={r.id} />}
          {!r.mine && (
            <div className="mt-3 flex gap-2">
              {r.status === "pending" && <><button className={btn} onClick={() => act(r.id, "approve")}>Approve</button><button className="rounded-md border border-line px-4 py-2 text-sm" onClick={() => act(r.id, "decline")}>Decline</button></>}
              {r.status === "confirmed" && <button className={btn} onClick={() => setScan({ id: r.id, action: "handover" })}>Confirm handover</button>}
              {r.status === "handed_over" && <button className={btn} onClick={() => setScan({ id: r.id, action: "return" })}>Confirm return</button>}
            </div>
          )}
        </div>
      ))}
      {!rows.length && <p className="text-fog">No requests yet. Find an item to borrow, or list one to lend.</p>}
    </div>
  );
}

function NewItem({ done }: { done: () => void }) {
  const [f, setF] = useState({ title: "", description: "", category: CATS[0], location: "" });
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState("");
  const save = async () => {
    try {
      let imageUrl: string | undefined;
      if (file) {
        const { data: u } = await supabase.auth.getUser();
        const path = `${u.user!.id}/${crypto.randomUUID()}-${file.name.replace(/[^\w.]/g, "_")}`;
        const up = await supabase.storage.from("item-images").upload(path, file);
        if (up.error) throw up.error;
        imageUrl = supabase.storage.from("item-images").getPublicUrl(path).data.publicUrl;
      }
      await api("/api/items", { method: "POST", body: { ...f, imageUrl } }); done();
    } catch (e: any) { setMsg(e.message); }
  };
  return (
    <div className="max-w-md space-y-3">
      <input placeholder="What are you lending?" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      <textarea rows={3} placeholder="Condition, pickup spot, anything borrowers should know" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
      <input placeholder="Pickup spot, e.g. Library entrance" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
      <input type="file" accept="image/*" aria-label="Item photo" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <button className={btn} onClick={save}>List item</button>
      {msg && <p className="text-sm" role="alert">{msg}</p>}
    </div>
  );
}

function Need() {
  const [cat, setCat] = useState(CATS[0]);
  const [hours, setHours] = useState(4);
  const [loc, setLoc] = useState("");
  const [msg, setMsg] = useState("");
  const go = async () => {
    try {
      const r = await api<{ matched: string[] }>("/api/need", { method: "POST", body: { category: cat, hours, location: loc } });
      setMsg(r.matched.length ? `Asked ${r.matched.length} owner(s) about: ${r.matched.join(", ")}. Watch My requests.` : "Nothing is free right now. Try another category or a shorter window.");
    } catch (e: any) { setMsg(e.message); }
  };
  return (
    <div className="max-w-md space-y-3">
      <p className="text-fog">Starting now, for how long? We’ll ask the owners most likely to say yes.</p>
      <select value={cat} onChange={(e) => setCat(e.target.value)}>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
      <input placeholder="Where are you? Owners at the same spot rank first" value={loc} onChange={(e) => setLoc(e.target.value)} />
      <input type="number" min={1} max={72} aria-label="Hours needed" value={hours} onChange={(e) => setHours(Number(e.target.value))} />
      <button className={btn} onClick={go}>Ask owners now</button>
      {msg && <p className="text-sm" role="status">{msg}</p>}
    </div>
  );
}

function Chat({ id }: { id: string }) {
  const [msgs, setMsgs] = useState<{ id: string; body: string; mine: boolean }[]>([]);
  const [text, setText] = useState("");
  const load = () => api<typeof msgs>(`/api/requests/${id}/messages`).then(setMsgs).catch(() => {});
  useEffect(() => {
    load();
    const ch = supabase.channel(`chat-${id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `request_id=eq.${id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [id]);
  const send = async () => {
    if (!text.trim()) return;
    await api(`/api/requests/${id}/messages`, { method: "POST", body: { body: text } }).catch(() => {});
    setText(""); load();
  };
  return (
    <div className="mt-3 space-y-1 border-t border-line pt-3">
      {msgs.map((m) => <p key={m.id} className={`text-sm ${m.mine ? "text-right" : ""}`}><span className="inline-block rounded-md bg-ivory px-2 py-1">{m.body}</span></p>)}
      <div className="flex gap-2">
        <input placeholder="Agree a pickup spot and time" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
        <button className={btn} onClick={send}>Send</button>
      </div>
    </div>
  );
}

const nextDay = (d: Date) => { const n = new Date(d); n.setDate(n.getDate() + 1); return n; };

function Availability({ id }: { id: string }) {
  const days = Array.from({ length: 14 }, (_, n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; });
  const [wins, setWins] = useState<{ id: string; start: string; end: string }[]>([]);
  const load = () => api<typeof wins>(`/api/items/${id}/availability`).then(setWins).catch(() => {});
  useEffect(() => { load(); }, [id]);
  const find = (d: Date) => wins.find((w) => +new Date(w.start) === +d && +new Date(w.end) === +nextDay(d));
  const toggle = async (d: Date) => {
    const w = find(d);
    if (w) await api(`/api/availability/${w.id}`, { method: "DELETE" }).catch(() => {});
    else await api(`/api/items/${id}/availability`, { method: "POST", body: { start: d.toISOString(), end: nextDay(d).toISOString() } }).catch(() => {});
    load();
  };
  return (
    <div className="mt-4">
      <p className="text-sm text-fog">Tap the days this item is free to borrow. With no days set, it’s open any time.</p>
      <div className="mt-2 grid grid-cols-7 gap-1">
        {days.map((d) => (
          <button key={+d} onClick={() => toggle(d)} aria-pressed={!!find(d)}
            className={`rounded-md border px-1 py-2 text-xs ${find(d) ? "border-forest bg-forest text-ivory" : "border-line bg-paper"}`}>
            {d.toLocaleDateString([], { weekday: "short", day: "numeric" })}
          </button>
        ))}
      </div>
    </div>
  );
}

function Admin() {
  const [d, setD] = useState<any>(null);
  const load = () => api("/api/admin/overview").then(setD).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!d) return null;
  return (
    <div>
      <dl className="flex flex-wrap gap-x-10 gap-y-3 text-sm">
        <Stat n={d.users} l="students" /><Stat n={d.items} l="listed items" /><Stat n={d.requests} l="requests" /><Stat n={d.returned} l="returned" /><Stat n={d.declined} l="declined" />
      </dl>
      <ul className="mt-6 divide-y divide-line">
        {d.recent.map((i: any) => (
          <li key={i.id} className="flex items-center justify-between py-2 text-sm">
            <span>{i.title} <span className="text-fog">from {i.owner_name}</span></span>
            <button className="underline" onClick={() => api(`/api/admin/items/${i.id}`, { method: "DELETE" }).then(load)}>Remove listing</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Scanner({ onPin, onManual, onClose }: { onPin: (p: string) => void; onManual: () => void; onClose: () => void }) {
  const [err, setErr] = useState("");
  useEffect(() => {
    const s = new Html5Qrcode("qr-reader");
    let done = false;
    s.start({ facingMode: "environment" }, { fps: 10, qrbox: 220 }, (text) => { if (!done && /^\d{6}$/.test(text)) { done = true; onPin(text); } }, () => {})
      .catch(() => setErr("We couldn’t open the camera. Allow camera access, or type the PIN instead."));
    return () => { s.stop().then(() => s.clear()).catch(() => {}); };
  }, []);
  return (
    <div role="dialog" aria-label="Scan the PIN QR code" className="fixed inset-0 z-20 grid place-items-center bg-forest/80 p-5">
      <div className="w-full max-w-sm rounded-lg bg-paper p-5">
        <h2 className="font-display text-2xl">Scan the borrower’s QR code</h2>
        <div id="qr-reader" className="mt-3 overflow-hidden rounded-md" />
        {err && <p className="mt-2 text-sm" role="alert">{err}</p>}
        <div className="mt-4 flex items-center gap-4">
          <button className={btn} onClick={onManual}>Type the PIN instead</button>
          <button className="text-sm underline" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
