// Envia os lembretes da Horta do Joaquim como notificação push.
// - Chamado de hora em hora pelo pg_cron (header x-cron-secret): manda o resumo do dia para quem tem notify_hour = hora atual (Brasília).
// - Chamado pelo app com o login do usuário e {"test": true}: manda uma notificação de teste só para ele.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const TZ = "America/Sao_Paulo";
const todayBR = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
const hourBR = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date())) % 24;
const dayNum = (s: string) => Math.floor(Date.parse(s.slice(0, 10) + "T00:00:00Z") / 86400000);
const localDay = (s: string) => (s.length <= 10 ? s : new Date(s).toLocaleDateString("en-CA", { timeZone: TZ }));
const daysSince = (s: string) => dayNum(todayBR()) - dayNum(localDay(s));
const fmt = (n: number) => n.toFixed(1).replace(".", ",");

async function remindersFor(uid: string, s: Record<string, any>) {
  const q = (t: string) => db.from(t).select("*").eq("user_id", uid);
  const [{ data: readings }, { data: events }, { data: plantings }, { data: species }] = await Promise.all([
    q("horta_readings").not("ph", "is", null).order("measured_at", { ascending: false }).limit(1),
    q("horta_events").eq("kind", "troca").order("happened_on", { ascending: false }).limit(1),
    q("horta_plantings").is("harvested_on", null),
    q("horta_species"),
  ]);
  const sp = new Map((species || []).map((x: any) => [x.id, x]));
  const active = plantings || [];
  const items: string[] = [];
  const last = readings?.[0];
  if (!last) items.push("⚗️ Meça o pH da água (ainda não há medição).");
  else {
    const d = daysSince(last.measured_at);
    if (d >= (s.ph_every_days ?? 2)) items.push(`⚗️ Hora de medir o pH (última há ${d} dias).`);
    const ss = [...new Set(active.map((p: any) => p.species_id))].map((id) => sp.get(id)).filter(Boolean) as any[];
    if (ss.length) {
      const min = Math.max(...ss.map((x) => +x.ph_min)), max = Math.min(...ss.map((x) => +x.ph_max));
      if (min <= max && (+last.ph < min || +last.ph > max)) items.push(`⚠️ pH ${+last.ph < min ? "baixo" : "alto"} (${fmt(+last.ph)}); alvo ${fmt(min)} a ${fmt(max)}.`);
    }
  }
  const troca = events?.[0];
  if (troca) {
    const left = (s.change_every_days ?? 14) - daysSince(troca.happened_on);
    if (left <= 0) items.push(`🔄 Trocar a solução nutritiva (última há ${daysSince(troca.happened_on)} dias).`);
    else if (left === 1) items.push("🔄 Amanhã é dia de trocar a solução.");
  }
  const ready = new Map<string, number>();
  for (const p of active) {
    const x: any = sp.get(p.species_id); if (!x?.days_to_harvest) continue;
    const age = daysSince(p.planted_on);
    const lastCut = p.last_harvest_on ? daysSince(p.last_harvest_on) : null;
    if (age >= x.days_to_harvest && (!x.continuous || lastCut == null || lastCut >= 14)) ready.set(x.name, (ready.get(x.name) || 0) + 1);
  }
  if (ready.size) items.push("🧺 Pronto para colher: " + [...ready].map(([n, c]) => `${n}${c > 1 ? ` (${c})` : ""}`).join(", ") + ".");
  return items;
}

async function sendTo(uid: string, payload: Record<string, unknown>) {
  const { data: subs } = await db.from("horta_push_subs").select("*").eq("user_id", uid);
  let ok = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 6 * 3600 });
      ok++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("horta_push_subs").delete().eq("id", s.id);
      else console.error("push falhou", e?.statusCode, e?.body);
    }
  }
  return { subs: subs?.length || 0, ok };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { data: cfg } = await db.from("horta_push_config").select("*").single();
  if (!cfg) return json({ error: "sem configuração" }, 500);
  webpush.setVapidDetails("https://qualitecsst.github.io/minha-horta/", cfg.vapid_public, cfg.vapid_private);
  const body = await req.json().catch(() => ({}));

  // Chamada do agendador
  if (req.headers.get("x-cron-secret")) {
    if (req.headers.get("x-cron-secret") !== cfg.cron_secret) return json({ error: "não autorizado" }, 401);
    const hour = body.force_hour ?? hourBR(), today = todayBR();
    const { data: settings } = await db.from("horta_settings").select("*").eq("notify_enabled", true).eq("notify_hour", hour);
    const out: unknown[] = [];
    for (const s of settings || []) {
      const { data: done } = await db.from("horta_push_log").select("kind").eq("user_id", s.user_id).eq("sent_on", today).eq("kind", "diario");
      if (done?.length) continue;
      const items = await remindersFor(s.user_id, s);
      if (!items.length) continue;
      const r = await sendTo(s.user_id, { title: "Horta do Joaquim 🌱", body: items.join("\n"), tag: "lembretes", url: "./" });
      if (r.ok) await db.from("horta_push_log").insert({ user_id: s.user_id, sent_on: today, kind: "diario" });
      out.push({ items: items.length, ...r });
    }
    return json({ hour, sent: out });
  }

  // Chamada do app (usuário logado)
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(token);
  if (!u?.user) return json({ error: "faça login" }, 401);
  const { data: s } = await db.from("horta_settings").select("*").eq("user_id", u.user.id).limit(1).maybeSingle();
  const items = await remindersFor(u.user.id, s || {});
  const r = await sendTo(u.user.id, {
    title: "Horta do Joaquim 🌱",
    body: items.length ? "Teste ok! Hoje: " + items.join("\n") : "Teste ok! Tudo em dia na horta. 🌿",
    tag: "teste", url: "./",
  });
  return json({ items, ...r });
});
