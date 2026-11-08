// =====================================================================
// 🤖 Admission credit by AI: works through the queue (admission_credits)
//   For each admitted lead it sends Claude the lead's story (people as
//   codes P1, P2…; no names or phone numbers) and saves the shares.
//   Who may wake it:
//     · the 2-minute job in the database (header x-cron-secret)
//     · any signed-in person (the app, right after "Admitted")
//   It answers at once and does the work in the background.
//   {"action":"test"} (admins): checks the saved Claude API key.
//   The key is set in the app (Settings → AI); only the server reads it.
// =====================================================================
import Anthropic from "npm:@anthropic-ai/sdk@1.6.0";

import { admin, asUser, cors, currentUser, json } from "../_shared/drive.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

type Settings = {
  enabled?: boolean;
  model?: string;
  effort?: string;
  guidance?: string;
};
type Config = {
  key: string | null;
  cron_secret: string | null;
  settings: Settings;
};
type Person = { code: string; user_id: string };
type Input = {
  people: Person[];
  stats: unknown[];
  lead: unknown;
  events: unknown[];
};
type Answer = {
  shares: { person: string; percent: number; reason: string }[];
  decisive_moment: string;
  confidence: "high" | "medium" | "low";
};

const DEFAULT_MODEL = "claude-sonnet-5-5";
const PARALLEL = 3; // leads at a time
const START_NEW_UNTIL_MS = 70_000; // no new lead after this
const CALL_TIMEOUT_MS = 90_000;

const SCHEMA = {
  type: "object",
  properties: {
    shares: {
      type: "array",
      items: {
        type: "object",
        properties: {
          person: { type: "string", description: "The person code, e.g. P1" },
          percent: { type: "integer", description: "Whole percent, 0-100" },
          reason: {
            type: "string",
            description: "One short sentence in Bangla",
          },
        },
        required: ["person", "percent", "reason"],
        additionalProperties: false,
      },
    },
    decisive_moment: {
      type: "string",
      description: "One short sentence in Bangla",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["shares", "decisive_moment", "confidence"],
  additionalProperties: false,
} as const;

const SYSTEM = `You share out the credit for one student's admission at a college admission office in Bangladesh, among the staff who worked on the lead.

You get the lead's story: when it was added and from where, every call (direction, answered or not, minutes, the caller's note), WhatsApp calls and messages, notes, campus visits, papers received, fee talks and payments, hand-overs (assigned … to …), stage moves, and who pressed "Admitted". People are codes (P1, P2…). "stats" has each person's totals.

Weigh real influence on the decision, not clicks:
- Conversations that moved the student: answered calls, talk minutes, notes that show real understanding (needs, doubts, family, fees) and follow-through.
- The work near the decision counts most: the campus visit, fee agreement, papers, the closing talk.
- Bringing the lead (adding it from a real contact or referral) earns a fair part; a bulk import with no talk earns little.
- Steady follow-up over weeks counts; many unanswered calls alone count little.
- Pressing "Admitted" or taking the payment is office work: a small part unless that person also did the talking.
- A hand-over is not work in itself; judge what each person did.
- Only people in "people" can get a share. Give 0 to (or leave out) those who did nothing that mattered.

Answer:
- shares: whole percents that add up to exactly 100, with one short reason each in simple Bangla (what that person did that mattered).
- decisive_moment: one short sentence in simple Bangla: what turned the student.
- confidence: high when the story is clear, low when there is little to go on (few notes, no talk).`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const cfg = await config();

    // who is asking
    const secret = req.headers.get("x-cron-secret");
    const fromJob = !!secret && !!cfg.cron_secret && secret === cfg.cron_secret;
    if (!fromJob) {
      const user = await currentUser(req);
      if (!user) return json({ error: "Please sign in again." }, 401);
    }

    if (body.action === "test") {
      if (fromJob) return json({ error: "Not allowed." }, 403);
      const { data: isAdmin } = await asUser(req).rpc("has_permission", {
        perm: "settings.manage",
      });
      if (!isAdmin) return json({ error: "Only an admin can do this." }, 403);
      if (!cfg.key)
        return json(
          { error: "No Claude API key is saved.", code: "no_key" },
          409,
        );
      return json(await testKey(cfg));
    }

    if (!cfg.key) return json({ ok: false, code: "no_key" });
    if (cfg.settings.enabled === false) return json({ ok: false, code: "off" });

    const work = drain(cfg).catch((e) =>
      console.error("ai-admission-credit", e),
    );
    if (typeof EdgeRuntime !== "undefined") {
      EdgeRuntime.waitUntil(work);
      return json({ ok: true, started: true }, 202);
    }
    await work;
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

async function config(): Promise<Config> {
  const { data, error } = await admin.rpc("ai_credit_server_config");
  if (error) throw new Error(error.message);
  const c = (data ?? {}) as Partial<Config>;
  return {
    key: c.key ?? null,
    cron_secret: c.cron_secret ?? null,
    settings: c.settings ?? {},
  };
}

function client(cfg: Config) {
  return new Anthropic({
    apiKey: cfg.key!,
    timeout: CALL_TIMEOUT_MS,
    maxRetries: 1,
  });
}

// A free check: can this key see the model?
async function testKey(cfg: Config) {
  const model = cfg.settings.model || DEFAULT_MODEL;
  try {
    await client(cfg).models.retrieve(model);
    await admin.rpc("ai_key_result", { p_ok: true, p_error: null });
    return { ok: true, model };
  } catch (e) {
    const msg = explain(e);
    if (
      e instanceof Anthropic.AuthenticationError ||
      e instanceof Anthropic.PermissionDeniedError
    ) {
      await admin.rpc("ai_key_result", { p_ok: false, p_error: msg });
    }
    return { ok: false, error: msg };
  }
}

// Take leads from the queue until it is empty or time is up
async function drain(cfg: Config) {
  const started = Date.now();
  const ai = client(cfg);
  let stop = false;
  while (!stop && Date.now() - started < START_NEW_UNTIL_MS) {
    const { data, error } = await admin.rpc("ai_credit_claim", {
      p_limit: PARALLEL,
    });
    if (error) throw new Error(error.message);
    const ids = ((data ?? []) as unknown[]).map((x) =>
      typeof x === "string" ? x : (x as Record<string, string>).ai_credit_claim,
    );
    if (ids.length === 0) break;
    const results = await Promise.all(ids.map((id) => one(ai, cfg, id)));
    if (results.includes("stop")) stop = true;
  }
}

async function one(
  ai: Anthropic,
  cfg: Config,
  leadId: string,
): Promise<"ok" | "stop"> {
  try {
    const { data: input, error } = await admin.rpc("admission_credit_input", {
      p_lead: leadId,
    });
    if (error) throw new Error(error.message);
    if (!input) {
      await admin.rpc("ai_credit_fail", {
        p_lead: leadId,
        p_error: "Not admitted any more.",
        p_retry: false,
      });
      return "ok";
    }
    const story = input as Input;
    if (story.people.length === 0) {
      await admin.rpc("ai_credit_fail", {
        p_lead: leadId,
        p_error: "Nobody worked on this lead.",
        p_retry: false,
      });
      return "ok";
    }

    const extra = (cfg.settings.guidance ?? "").trim();
    const effort =
      (["low", "medium", "high"] as const).find(
        (x) => x === cfg.settings.effort,
      ) ?? "medium";
    const res = await ai.beta.messages.create({
      model: cfg.settings.model || DEFAULT_MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort,
        format: { type: "json_schema", schema: SCHEMA },
      },
      system: extra
        ? `${SYSTEM}\n\nThe college's own rules (follow them):\n${extra}`
        : SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(story) }],
    });

    if (res.stop_reason === "refusal") {
      await admin.rpc("ai_credit_fail", {
        p_lead: leadId,
        p_error: "The AI declined this one.",
        p_retry: false,
      });
      return "ok";
    }
    if (res.stop_reason === "max_tokens")
      throw new Error("The answer was cut short.");
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const answer = JSON.parse(text) as Answer;

    const byCode = new Map(story.people.map((p) => [p.code, p.user_id]));
    const shares = answer.shares
      .filter((s) => byCode.has(s.person) && s.percent > 0)
      .map((s) => ({
        user_id: byCode.get(s.person),
        share: s.percent,
        reason: s.reason,
      }));
    // the numbers on the card: user ids in place of the codes
    const stats = (story.stats as Record<string, unknown>[]).map(
      ({ person, ...rest }) => ({
        user_id: byCode.get(String(person)),
        ...rest,
      }),
    );

    const { error: saveError } = await admin.rpc("ai_credit_save", {
      p_lead: leadId,
      p_shares: shares,
      p_decisive: answer.decisive_moment,
      p_confidence: answer.confidence,
      p_stats: stats,
      p_model: res.model,
      p_usage: {
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
      },
    });
    if (saveError) throw new Error(saveError.message);
    await admin.rpc("ai_key_result", { p_ok: true, p_error: null });
    return "ok";
  } catch (e) {
    const msg = explain(e);
    if (
      e instanceof Anthropic.AuthenticationError ||
      e instanceof Anthropic.PermissionDeniedError
    ) {
      await admin.rpc("ai_key_result", { p_ok: false, p_error: msg });
      await admin.rpc("ai_credit_release", { p_lead: leadId });
      return "stop";
    }
    if (
      e instanceof Anthropic.BadRequestError &&
      /credit balance/i.test(e.message)
    ) {
      // no credit left: wait until an admin presses Test again (Settings → AI)
      await admin.rpc("ai_key_result", { p_ok: false, p_error: msg });
      await admin.rpc("ai_credit_release", { p_lead: leadId });
      return "stop";
    }
    if (
      e instanceof Anthropic.RateLimitError ||
      (e instanceof Anthropic.APIError && e.status === 529)
    ) {
      await admin.rpc("ai_credit_release", { p_lead: leadId });
      return "stop";
    }
    await admin.rpc("ai_credit_fail", {
      p_lead: leadId,
      p_error: msg,
      p_retry: true,
    });
    return "ok";
  }
}

function explain(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError)
    return "The Claude API key was refused. Save a new key in Settings → AI.";
  if (e instanceof Anthropic.PermissionDeniedError)
    return "This key may not use the model.";
  if (e instanceof Anthropic.NotFoundError) return "The model was not found.";
  if (e instanceof Anthropic.RateLimitError)
    return "Claude is busy or the credit ran out; it will try again.";
  if (e instanceof Anthropic.BadRequestError) {
    return /credit balance/i.test(e.message)
      ? "The Claude API credit has run out."
      : `Claude: ${e.message}`;
  }
  if (e instanceof Anthropic.APIError)
    return `Claude ${e.status ?? ""}: ${e.message}`.trim();
  return e instanceof Error ? e.message : String(e);
}
