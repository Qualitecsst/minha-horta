// Diagnóstico por foto da Horta do Joaquim: recebe uma foto de planta e o contexto da horta,
// pergunta ao Claude o que pode ser e guarda a resposta em horta_diagnoses.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@1.5.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MODEL = "claude-opus-5-5";
const LIMITE_DIA = 30;

const SYSTEM = `Você ajuda o Douglas a cuidar de uma horta hidropônica caseira (sistema NFT, tubos de PVC, solução nutritiva em caixa).
Ele manda a foto de uma planta e às vezes uma pergunta. Responda em português do Brasil, de forma simples e direta, para um hobista.

Estrutura da resposta (use exatamente estes títulos em negrito, sem outros títulos):
**O que estou vendo:** uma ou duas frases sobre a planta e os sinais visíveis na foto.
**Causas mais prováveis:** até 3 hipóteses, da mais para a menos provável, cada uma em uma linha começando com "- " e com o motivo curto. Considere deficiência ou excesso de nutrientes, pH fora da faixa (bloqueio de nutrientes), EC, calor ou água quente, falta de oxigênio nas raízes, excesso de sol ou queimadura, pragas (pulgão, mosca-branca, ácaro, tripes, lagarta) e doenças (fungos, podridão de raiz).
**O que fazer agora:** de 2 a 4 passos práticos em linhas começando com "- ", priorizando o que é barato e reversível (medir pH e EC, conferir a temperatura da água, trocar a solução, retirar folhas afetadas, isolar a planta). Use doses só quando forem comuns e seguras.
**Para confirmar:** uma frase sobre o que observar nos próximos dias, ou que foto tirar para tirar a dúvida.

Use os dados da horta enviados junto (pH, EC, idade da planta) para pesar as hipóteses. Se a foto não mostrar bem o problema, diga isso e peça uma foto mais próxima, com luz natural. Se a planta parecer saudável, diga isso. Nunca indique agrotóxicos; prefira manejo e produtos caseiros ou biológicos (sabão neutro diluído, óleo de neem) quando houver praga. Seja breve: no máximo umas 180 palavras.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Autoteste (só com o segredo do agendador): confere se a chave do Claude funciona, sem foto.
  const cron = req.headers.get("x-cron-secret");
  if (cron) {
    const { data: cfg } = await db.from("horta_push_config").select("cron_secret").single();
    if (!cfg || cron !== cfg.cron_secret) return json({ error: "não autorizado" }, 401);
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ ok: false, reason: "sem_chave" });
    try {
      const r = await new Anthropic({ apiKey: key }).messages.create({ model: MODEL, max_tokens: 300, output_config: { effort: "low" }, messages: [{ role: "user", content: "Responda só: ok" }] });
      return json({ ok: true, model: r.model, stop: r.stop_reason });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) return json({ ok: false, reason: "chave_invalida" });
      if (e instanceof Anthropic.PermissionDeniedError) return json({ ok: false, reason: "sem_permissao" });
      if (e instanceof Anthropic.APIError) return json({ ok: false, reason: `api_${e.status}`, msg: e.message?.slice(0, 200) });
      return json({ ok: false, reason: "rede" });
    }
  }

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(token);
  if (!u?.user) return json({ error: "Faça login para usar o diagnóstico." }, 401);
  const uid = u.user.id;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "O diagnóstico ainda não foi ligado (falta a chave do Claude)." }, 503);

  const body = await req.json().catch(() => null);
  const image: string | undefined = body?.image;
  if (!image || image.length > 7_000_000) return json({ error: "Foto ausente ou grande demais." }, 400);

  const since = new Date(Date.now() - 86400000).toISOString();
  const { count } = await db.from("horta_diagnoses").select("id", { count: "exact", head: true }).eq("user_id", uid).gte("created_at", since);
  if ((count ?? 0) >= LIMITE_DIA) return json({ error: `Limite de ${LIMITE_DIA} diagnósticos por dia atingido.` }, 429);

  const c = body.context || {};
  const ctx = [
    c.species && `Planta: ${c.species}${c.age_days != null ? `, ${c.age_days} dias no tubo` : ""}.`,
    c.ph != null && `Último pH da solução: ${c.ph}${c.ph_when ? ` (${c.ph_when})` : ""}. Faixa alvo das plantas: ${c.ph_target || "5,5 a 6,5"}.`,
    c.ec != null ? `Última EC: ${c.ec} mS/cm.` : "EC: não medida (ainda não tem medidor).",
    c.water_temp != null && `Temperatura da água: ${c.water_temp} °C.`,
    c.days_since_change != null && `Solução trocada há ${c.days_since_change} dias.`,
    c.air_max != null && `Máxima prevista hoje: ${c.air_max} °C.`,
  ].filter(Boolean).join("\n");
  const question = (body.question || "").toString().slice(0, 500);

  const client = new Anthropic({ apiKey });
  let resp;
  try {
    resp = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: `Dados da horta:\n${ctx || "(sem dados)"}\n\nPergunta do Douglas: ${question || "O que essa planta tem?"}` },
        ],
      }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "A chave do Claude não foi aceita. Confira a chave cadastrada." }, 502);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "Muitos pedidos agora. Tente de novo em um minuto." }, 429);
    if (e instanceof Anthropic.BadRequestError) return json({ error: "O Claude não aceitou o pedido: " + e.message }, 502);
    if (e instanceof Anthropic.APIError) return json({ error: `Erro no Claude (${e.status}). Tente de novo.` }, 502);
    return json({ error: "Falha ao falar com o Claude." }, 502);
  }

  if (resp.stop_reason === "refusal") return json({ error: "O Claude não quis analisar essa foto. Tente outra foto da planta." }, 422);
  const text = resp.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
  if (!text) return json({ error: "Resposta vazia. Tente de novo." }, 502);

  const { data: row } = await db.from("horta_diagnoses").insert({
    user_id: uid, planting_id: body.planting_id || null, photo_path: body.photo_path || null, question: question || null,
    result: text, model: resp.model, input_tokens: resp.usage?.input_tokens, output_tokens: resp.usage?.output_tokens,
  }).select().single();
  return json({ result: text, diagnosis: row });
});
