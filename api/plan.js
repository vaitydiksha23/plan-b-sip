// Plan B MVP: server function (Vercel).
// Calls Claude, removes personal details, runs runtime quality checks, returns structured output.
// The API key comes from the ANTHROPIC_API_KEY environment variable. Never put it in code.

const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' };
const DEFAULT_MODEL = process.env.MODEL || MODELS.haiku;

const CATEGORIES = ['one_off', 'multi_month', 'uncertain', 'planned_break', 'wants_to_stop', 'out_of_scope', 'unclear'];
const CONFIDENCE = ['high', 'medium', 'low'];
const DURATIONS = ['one_month', 'two_months', 'three_plus_months', 'unknown', 'not_applicable'];
const FITS = ['fits', 'partly', 'does_not_fit', 'no_plan_b', 'not_applicable'];
const PLACEHOLDERS = ['{sip_date}', '{salary_date}', '{next_debit_date}', '{act_by_date}', '{return_date}'];

// ---------- Runtime check patterns ----------
const MONTHS = /\b(january|february|march|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept|oct|nov|dec)\b/i;
const WEEKDAYS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const CURRENCY = /(₹|\brs\.?(?=\s|\d|$)|\brupees?\b|\binr\b|\blakhs?\b|\bcrores?\b)/i;
const FUND_WORDS = /\b(funds?|mutual|nifty|sensex|index|small ?caps?|mid ?caps?|large ?caps?|flexi ?caps?|elss|etfs?|stocks?|equity|portfolio|nav|amc|sbi|hdfc|icici|axis|nippon|parag|quant|kotak|mirae|motilal|uti|dsp|birla|bandhan|edelweiss)\b/i;
const ADVICE = /(you should (invest|buy|sell|switch|move)|i('d| would)? recommend|(your|the|good|high|higher|better|low|lower) returns|returns (on|from)|good time to|the market will|best (option|place) to invest|invest (in|instead))/i;
const FEAR = /(lose everything|you('|’)?ll lose|you will lose|hurry|urgent|immediately|act now|right away|don'?t miss|miss out|regret|too late|last chance|panic|crash|you must|you have to|don'?t stop|do not stop|shouldn'?t stop|keep investing|stay invested|reconsider|are you sure|think again|losing out)/i;

const RULES_TEXT = `Hard rules for every piece of text you write:
- Never write digits, dates, month names, weekday names, amounts or currency. If you must refer to a date, use only these placeholders, exactly as written: {sip_date}, {salary_date}, {next_debit_date}, {act_by_date}, {return_date}. Usually you need none.
- Never mention funds, fund houses, markets, returns, stocks, NAV, portfolios or where to invest. Never give investment advice. Avoid the words "fund", "market" and "returns" entirely.
- Never pressure, warn, rush, guilt or persuade. If someone wants to stop or take a break, respect it fully and do not try to change their mind.
- Write plain, warm, short English, in the second person ("you"). No exclamation marks.
- Never repeat any number, PAN, account number or "[removed]" text the person typed.`;

const CLASSIFY_SYSTEM = `You are the understanding step inside "Plan B", a scheduling helper for first-time SIP investors on Groww in India. A person has told you about a tight month. Your only jobs: understand their situation, classify it, and reflect it back in plain words. Fixed software, not you, decides every option, date, rule and next step.

${RULES_TEXT}

Categories (pick exactly one):
- one_off: one tight month; they expect the next month to be normal, or the problem is already fixed.
- multi_month: a tight stretch of two or more months with a rough end, and they do not say they want to stop or take a break.
- uncertain: money is tight and they do not know for how long.
- planned_break: they say they want to stop for a while and come back later.
- wants_to_stop: they want to end the SIP, with no intent to return.
- out_of_scope: they ask about funds, markets, returns, where else to invest, whether to stop because of the market, or they ask you to pressure, scare or push them. This wins over every other category, even if a money situation is also described.
- unclear: not enough information to tell.

Boundary rules:
- Stated intent decides between multi_month and planned_break. Describing tight months is multi_month. Saying "I want a break and will restart" is planned_break.
- Any stated intent to return later means planned_break, not wants_to_stop.

Hindi and Hinglish: understand them fully, and always write your own text in simple English.

Fields:
- expected_duration: one_month | two_months | three_plus_months | unknown | not_applicable. Use not_applicable for out_of_scope, wants_to_stop and unclear. For planned_break, use the length of the break if stated, else unknown.
- confidence: high | medium | low. Use low when you are guessing.
- followup_question: if the category is unclear or your confidence is low, write ONE short, neutral question that would help you classify. No options, no advice. Otherwise "".
- reflection: one or two sentences reflecting what you understood about their situation, without judging it. For out_of_scope, write "".
- plan_b_fit: if they have a Plan B, say whether it fits this situation: fits | partly | does_not_fit. If they have no Plan B, use no_plan_b. For out_of_scope and wants_to_stop, use not_applicable.
- plan_b_fit_reason: one sentence explaining the fit in terms of their situation, not dates. Use "" for no_plan_b and not_applicable.

Return ONLY a JSON object, with no other text:
{"category":"","confidence":"","expected_duration":"","followup_question":"","reflection":"","plan_b_fit":"","plan_b_fit_reason":""}`;

const SUMMARY_SYSTEM = `You write the month summary inside "Plan B", a scheduling helper for first-time SIP investors on Groww in India. You get what the person told us about their month. Write two or three short sentences that describe their month back to them so they can confirm it: how reliable their salary is, their big regular payments and roughly when they go out, and anything coming up that they mentioned. You may refer to their salary date as {salary_date} and their SIP date as {sip_date}.

${RULES_TEXT}

Hindi and Hinglish: understand them fully, and always write in simple English.

Return ONLY a JSON object, with no other text:
{"summary":""}`;

// ---------- Helpers ----------
function maskPII(text) {
  let t = String(text || '').slice(0, 1500);
  let found = false;
  const rules = [
    /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi,        // PAN
    /\b\d{4}\s?\d{4}\s?\d{4}\b/g,         // Aadhaar-like
    /\b\d{9,18}\b/g                       // account or phone numbers
  ];
  for (const r of rules) {
    t = t.replace(r, () => { found = true; return '[removed]'; });
  }
  return { text: t, found };
}

async function callClaude(model, system, userText) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: userText }]
    })
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error('api_' + r.status + ': ' + detail.slice(0, 200));
  }
  const data = await r.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

function parseJSON(raw) {
  if (!raw) return null;
  const clean = raw.replace(/```json|```/g, '').trim();
  const a = clean.indexOf('{');
  const b = clean.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(clean.slice(a, b + 1)); } catch (e) { return null; }
}

function textChecks(texts) {
  const joined = texts.filter(Boolean).join(' \n ');
  const stripped = PLACEHOLDERS.reduce((t, p) => t.split(p).join(' '), joined);
  const literal = /\d/.test(stripped) || MONTHS.test(stripped) || WEEKDAYS.test(stripped) ||
    CURRENCY.test(stripped) || /\{[^}]*\}/.test(stripped);
  return {
    c1: !(FUND_WORDS.test(joined) || ADVICE.test(joined)),
    c2: !literal,
    c3: !FEAR.test(joined)
  };
}

function checkList({ c1 = true, c2 = true, c3 = true, c7 = true, confidence = null, category = null, pii = false }) {
  return [
    { id: 'C1', label: 'No fund names or investment advice', pass: c1 },
    { id: 'C2', label: 'No dates or amounts written by the AI', pass: c2 },
    { id: 'C3', label: 'No pressure, fear or urgency', pass: c3 },
    { id: 'C4', label: 'Confident enough to answer', pass: confidence ? confidence !== 'low' : true },
    { id: 'C5', label: category === 'out_of_scope' ? "Outside Plan B's scope, so redirected" : "Within Plan B's scope", pass: true },
    { id: 'C6', label: pii ? 'Personal details removed before reading' : 'No personal details found', pass: true },
    { id: 'C7', label: 'Answer in the expected format', pass: c7 }
  ];
}

const SYNONYMS = {
  oneoff: 'one_off', one_off: 'one_off', one_time: 'one_off',
  multimonth: 'multi_month', multi_month: 'multi_month', multiple_months: 'multi_month',
  planned_break: 'planned_break', break: 'planned_break', take_a_break: 'planned_break',
  wants_to_stop: 'wants_to_stop', stop: 'wants_to_stop', want_to_stop: 'wants_to_stop',
  out_of_scope: 'out_of_scope', outofscope: 'out_of_scope',
  uncertain: 'uncertain', unclear: 'unclear'
};
function norm(v) {
  return String(v || '').toLowerCase().trim().replace(/[\s\-]+/g, '_').replace(/[^a-z_]/g, '');
}
function pick(v, list, fallback) {
  const s = norm(v);
  if (list.includes(s)) return s;
  if (SYNONYMS[s] && list.includes(SYNONYMS[s])) return SYNONYMS[s];
  return fallback;
}

// ---------- Tasks ----------
async function classify(p, model, debug) {
  const main = maskPII(p.user_text);
  const followups = (Array.isArray(p.followups) ? p.followups.slice(0, 2) : []).map(f => ({
    q: String(f.q || '').slice(0, 300),
    a: maskPII(f.a)
  }));
  const pii = main.found || followups.some(f => f.a.found);

  const fuText = followups.length
    ? followups.map((f, i) => `Question ${i + 1}: ${f.q}\nTheir answer: ${f.a.text}`).join('\n')
    : 'none';

  const userText = `Context:
- How they arrived: ${String(p.entry || 'opened Plan B themselves').slice(0, 100)}
- Their Plan B: ${String(p.plan_b || 'none').slice(0, 200)}
- Instalments skipped or missed in a row so far: ${Number(p.nonpayments) || 0}
- Earlier follow-up questions and answers:
${fuText}

What they wrote:
"""${main.text}"""`;

  let note = '';
  let out = null;
  let checks = null;
  let attempts = 0;
  let formatOk = false;
  let lastRaw = '';

  while (attempts < 2) {
    attempts++;
    const raw = await callClaude(model, CLASSIFY_SYSTEM, userText + note);
    lastRaw = raw;
    const j = parseJSON(raw);
    if (!j || pick(j.category, CATEGORIES, null) === null) {
      formatOk = false;
      note = '\n\nYour previous reply was not valid. Reply with only the JSON object in the required format.';
      continue;
    }
    formatOk = true;
    out = {
      category: pick(j.category, CATEGORIES, 'unclear'),
      confidence: pick(j.confidence, CONFIDENCE, 'low'),
      expected_duration: pick(j.expected_duration, DURATIONS, 'unknown'),
      followup_question: String(j.followup_question || '').slice(0, 300),
      reflection: String(j.reflection || '').slice(0, 600),
      plan_b_fit: pick(j.plan_b_fit, FITS, 'not_applicable'),
      plan_b_fit_reason: String(j.plan_b_fit_reason || '').slice(0, 400)
    };
    const t = textChecks([out.reflection, out.plan_b_fit_reason, out.followup_question]);
    checks = { ...t };
    if (!t.c2 && attempts < 2) {
      note = '\n\nYour previous reply broke the rule about digits, dates, month or weekday names, amounts or placeholders. Rewrite your text following the rules. Reply with only the JSON object.';
      continue;
    }
    break;
  }

  if (!formatOk) {
    const r = { ok: false, reason: 'format', attempts, pii, checks: checkList({ c7: false, pii }) };
    if (debug) r.raw_preview = String(lastRaw).slice(0, 300);
    return r;
  }
  const list = checkList({ ...checks, confidence: out.confidence, category: out.category, pii });
  if (!checks.c1 || !checks.c2 || !checks.c3) {
    return { ok: false, reason: 'quality_check', attempts, pii, checks: list };
  }
  return { ok: true, model, attempts, pii, result: out, checks: list };
}

async function summary(p, model) {
  const up = maskPII(p.upcoming);
  const userText = `What they told us:
- Salary reliability: ${String(p.reliability || 'not given').slice(0, 100)}
- Big regular payments and timing: ${String(p.payments || 'none given').slice(0, 300)}
- Anything coming up, in their words: """${up.text}"""`;

  let note = '';
  let attempts = 0;
  let out = null;
  let checks = null;
  while (attempts < 2) {
    attempts++;
    const raw = await callClaude(model, SUMMARY_SYSTEM, userText + note);
    const j = parseJSON(raw);
    if (!j || !j.summary) {
      note = '\n\nReply with only the JSON object in the required format.';
      continue;
    }
    out = { summary: String(j.summary).slice(0, 700) };
    checks = textChecks([out.summary]);
    if (!checks.c2 && attempts < 2) {
      note = '\n\nYour previous reply broke the rule about digits, dates, month or weekday names, amounts or placeholders. Rewrite it following the rules. Reply with only the JSON object.';
      continue;
    }
    break;
  }
  if (!out) return { ok: false, reason: 'format', attempts, pii: up.found, checks: checkList({ c7: false, pii: up.found }) };
  const list = checkList({ ...checks, pii: up.found });
  if (!checks.c1 || !checks.c2 || !checks.c3) {
    return { ok: false, reason: 'quality_check', attempts, pii: up.found, checks: list };
  }
  return { ok: true, model, attempts, pii: up.found, result: out, checks: list };
}

// ---------- Handler ----------
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, reason: 'method' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(200).json({ ok: false, reason: 'config' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // Model override only for the eval page, protected by a passcode.
  let model = DEFAULT_MODEL;
  const pass = process.env.EVAL_PASS;
  const isEval = !!(pass && req.headers['x-eval-pass'] === pass);
  if (isEval && body.model && MODELS[body.model]) {
    model = MODELS[body.model];
  }

  try {
    if (body.task === 'classify') {
      res.status(200).json(await classify(body.payload || {}, model, isEval));
      return;
    }
    if (body.task === 'summary') {
      res.status(200).json(await summary(body.payload || {}, model));
      return;
    }
    res.status(400).json({ ok: false, reason: 'task' });
  } catch (e) {
    res.status(200).json({ ok: false, reason: 'error', detail: String(e.message || e).slice(0, 200) });
  }
};
