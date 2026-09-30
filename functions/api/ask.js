// Cloudflare Pages Function：POST /api/ask
//
// 收到问题 -> 在 entries.json 里按关键词找出最相关的条目 -> 连同回答规则一起发给大模型 -> 把模型的流式回答原样转给网页。
// 大模型的密钥只存在 Cloudflare 的环境变量里，网页上拿不到。
//
// 环境变量（在 Cloudflare Pages 的 Settings -> Variables and Secrets 里设置）：
//   DEEPSEEK_API_KEY  必填，DeepSeek 的密钥
//   ACCESS_CODE       必填，家人打开网页时要输的口令，防止别人用你的额度
//   MODEL             可选，默认 deepseek-chat
//   UPSTREAM_URL      可选，默认 https://api.deepseek.com/chat/completions（兼容 OpenAI 格式的接口都能换）

const TOP_K = 12;

// ---------- 检索：字符二元组 + BM25 ----------
// 中文没有空格分词，把每两个相邻汉字当一个词（"养老金" -> "养老","老金"），足够应付关键词匹配。

function tokenize(s) {
  const out = [];
  for (const run of s.toLowerCase().match(/[一-鿿]+|[a-z0-9]+/g) || []) {
    if (/^[a-z0-9]/.test(run)) out.push(run);
    else if (run.length === 1) out.push(run);
    else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

let INDEX = null; // 每个 worker 实例只建一次

function buildIndex(entries) {
  const FIELDS = [
    ["title", 3], ["secTitle", 2], ["secHint", 1.5], ["human", 2], ["gain", 1], ["note", 1], ["cost", 0.5],
  ];
  const docs = entries.map((e) => {
    const tf = new Map();
    let len = 0;
    for (const [f, w] of FIELDS) {
      for (const t of tokenize(e[f] || "")) {
        tf.set(t, (tf.get(t) || 0) + w);
        len += w;
      }
    }
    return { tf, len };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length;
  return { docs, df, avgLen, N: docs.length };
}

function search(index, entries, query, k) {
  const k1 = 1.2, b = 0.75;
  const q = [...new Set(tokenize(query))];
  const scores = index.docs.map((d, i) => {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t);
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / index.avgLen));
    }
    return [s, i];
  });
  return scores.filter(([s]) => s > 0).sort((a, b2) => b2[0] - a[0]).slice(0, k).map(([, i]) => entries[i]);
}

// ---------- 回答规则（改编自作者的 SKILL.md，给长辈看的版本） ----------

const SYSTEM_PROMPT = `你是一位家里的生活顾问，专门根据《高性价比人生指南》这本书回答问题。提问的人是长辈，年纪较大，没有专业背景。

## 只能根据下面「查到的条目」回答
- 回答里的每个数字、每条法规、每个结论，都要能对应到某一条查到的条目。条目里没有的数字、症状、法条，一律不要补。
- 每条建议末尾注明出处，格式是「第 8 节第 17 条（借条和担保）」，括号里写条目标题的关键词。
- 查到的条目里没有相关内容时，直接说「书里没有写这个」。可以补一句常识判断，但要明确说那是常识，不是书里的内容。
- 书把好处分成四类：寿命、时间精力、金钱、人身自由。不同类别的不要互相比较。

## 先看要不要马上停下
- 正在发生的急症（倒地没呼吸、大出血、火灾、溺水、触电、中毒、卒中或心梗症状）：第一句话先说打 120 或 119，再说现场第一个动作，不讲性价比。
- 提到自杀念头、活不下去：先给全国心理援助热线 12356，语气平和，不分析不评价。
- 已经被传唤、拘留、起诉：先指出书里对应条目，并说明个案要找律师。

## 怎么写
1. 先用一两句话给结论：该不该做、划不划算、第一步是什么。
2. 「先做这几条」：3 到 5 条，每条一到三行，动词开头，说清花什么、换回什么、证据等级和出处。按条目里标好的性价比（极高 > 高 > 一般）排，同档按证据等级 A > B > C 排。
3. 「别做的」：书里明确说不值得或有反面证据的，单独列。
4. 「书里没写的」：如实说。
5. 需要的话补一句：什么时候回头再看，或者出现什么信号要改主意。

## 语气和格式
- 说人话，像跟自己的爸妈解释。专业词当场用日常话解释一句。法条落到「会有什么后果、该怎么做」。
- 简体中文，不说教，不用感叹号，不追着劝。对方不照做是他自己的事。
- 篇幅控制在手机上一两屏能看完。用短段落和列表，不用表格。
- 数字照抄条目，不改。条目里写了年份、人群、置信区间的一并保留。
- 涉及金额、时限、名单的政策会变，提醒对方去官方渠道核实。
- 条目备注里标了「争议」的，把反方说法也提一句。标了「待核实」的，不当结论用。
- 只给条目「来源」栏里已有的链接，不引其他网站。

## 边界
这本书给的是通用做法，不替代医生、律师、会计。涉及具体病情、案件、税务，给方向并说该找谁，不替专业人士下结论。不给个性化投资建议。`;

function formatEntry(e) {
  const label = `第 ${e.sec} 节第 ${e.num} 条`;
  const tag = `钱=${e.money} 时间=${e.time} 毅力=${e.will} 收益=${e.level} 口径=${e.scope} 性价比=${e.ratio}`;
  return [
    `### ${label}：${e.title}`,
    `所属章节：${e.secTitle}`,
    `标签：${tag}${e.dispute ? "（争议）" : ""}${e.todo ? "（待核实）" : ""}`,
    `成本：${e.cost}`,
    `说人话：${e.human}`,
    `收益：${e.gain}`,
    `证据等级：${e.grade}`,
    `来源：${e.src}`,
    `备注：${e.note}`,
  ].join("\n");
}

// ---------- 请求处理 ----------

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求格式不对" }, 400);
  }
  const { question, history = [], code } = body;

  if (!env.ACCESS_CODE || code !== env.ACCESS_CODE) {
    return json({ error: "口令不对" }, 401);
  }
  if (!question || typeof question !== "string" || question.length > 500) {
    return json({ error: "问题为空或太长" }, 400);
  }
  if (!env.DEEPSEEK_API_KEY) {
    return json({ error: "服务器还没配置 DEEPSEEK_API_KEY" }, 500);
  }

  // 读条目库。同一个实例里只读一次。
  if (!INDEX) {
    const res = await env.ASSETS.fetch(new URL("/entries.json", request.url));
    const data = await res.json();
    INDEX = { entries: data.entries, index: buildIndex(data.entries), meta: { commit: data.commit, builtAt: data.builtAt } };
  }

  // 用当前问题加上一句上一轮的问题来检索，追问时不至于丢上下文
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content || "";
  const hits = search(INDEX.index, INDEX.entries, `${question} ${lastUser}`, TOP_K);

  const context = hits.length
    ? hits.map(formatEntry).join("\n\n")
    : "（没有查到相关条目）";

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-6).filter((m) => m.role === "user" || m.role === "assistant"),
    {
      role: "user",
      content: `## 查到的条目\n\n${context}\n\n## 问题\n\n${question}`,
    },
  ];

  const upstream = await fetch(env.UPSTREAM_URL || "https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.MODEL || "deepseek-chat",
      messages,
      stream: true,
      temperature: 0.3,
      max_tokens: 1500,
    }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text();
    return json({ error: `模型接口返回 ${upstream.status}`, detail: detail.slice(0, 300) }, 502);
  }

  // 把查到的条目列表放在响应头里，网页上可以展示「本次参考了哪些条目」
  const sources = hits.map((e) => ({
    label: `第 ${e.sec} 节第 ${e.num} 条`,
    title: e.title,
    url: `https://github.com/eternity4719/HowToLiveBetter/blob/main/${e.file}`,
  }));

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Sources": encodeURIComponent(JSON.stringify(sources)),
      "X-Book-Version": `${INDEX.meta.commit} ${INDEX.meta.builtAt}`,
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
