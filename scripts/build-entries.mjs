// 把《高性价比人生指南》的正文拆成一条条条目，生成 public/entries.json。
//
// 用法（在项目根目录）：
//   node scripts/build-entries.mjs            # 自动浅克隆最新的书到临时目录
//   node scripts/build-entries.mjs /path/to/HowToLiveBetter   # 用本地已有的仓库
//
// 不依赖任何 npm 包，Node 18 以上即可。

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/eternity4719/HowToLiveBetter.git";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "entries.json");

// 1. 拿到书
let root = process.argv[2];
if (!root) {
  root = mkdtempSync(join(tmpdir(), "hltb-"));
  console.log("克隆最新正文到", root);
  execSync(`git clone -q --depth 1 ${REPO} "${root}"`, { stdio: "inherit" });
}
if (!existsSync(join(root, "book"))) {
  console.error("找不到 book/ 目录，路径不对：", root);
  process.exit(1);
}

// 2. 从 index.html 里抠出性价比算法，不自己重写，作者改了这里会自动跟上
const html = readFileSync(join(root, "index.html"), "utf8");
const costLine = html.match(/const COST_W = (\{.*?\});/);
const ratioLine = html.match(/e\.ratio = ([\s\S]*?);\s*\n/);
if (!costLine || !ratioLine) {
  console.error("index.html 里找不到 COST_W 或 e.ratio，作者可能改了写法，请检查");
  process.exit(1);
}
const COST_W = new Function(`return ${costLine[1]}`)();
const ratioOf = new Function("e", `return ${ratioLine[1]}`);

// 3. README 里「这本书想回答的问题」那张表，给每一节配一句提示，检索时用
const readme = readFileSync(join(root, "README.md"), "utf8");
const secHint = {};
for (const m of readme.matchAll(/^\| (.+?) \| \[(\d+)\. .+?\]\(book\/.+?\) \|$/gm)) {
  secHint[Number(m[2])] = m[1];
}

// 4. 逐节、逐条解析
const FIELDS = { 成本: "cost", 说人话: "human", 收益: "gain", 证据等级: "grade", 来源: "src", 备注: "note" };
const entries = [];

for (const file of readdirSync(join(root, "book")).filter((f) => f.endsWith(".md")).sort()) {
  const text = readFileSync(join(root, "book", file), "utf8");
  const secMatch = text.match(/^# (\d+)\. (.+)$/m);
  if (!secMatch) continue;
  const sec = Number(secMatch[1]);
  const secTitle = secMatch[2].trim();

  // 按 "### N. 标题" 切块
  const blocks = text.split(/^(?=### \d+\. )/m).slice(1);
  for (const block of blocks) {
    const lines = block.split("\n");
    const head = lines[0].match(/^### (\d+)\. (.+)$/);
    if (!head) continue;
    const e = {
      id: `${sec}-${Number(head[1])}`,
      sec, secTitle, secHint: secHint[sec] || "",
      num: Number(head[1]),
      title: head[2].trim(),
      money: "", time: "", will: "", level: "", scope: "",
      cost: "", human: "", gain: "", grade: "", src: "", note: "",
      file: `book/${file}`,
    };

    let current = null;
    for (const raw of lines.slice(1)) {
      const line = raw.replace(/\s+$/, "");
      const tag = line.match(/^<!--\s*成本标签:(.*?)-->/);
      if (tag) {
        for (const kv of tag[1].trim().split(/\s+/)) {
          const [k, v] = kv.split("=");
          if (k === "钱") e.money = v;
          else if (k === "时间") e.time = v;
          else if (k === "毅力") e.will = v;
          else if (k === "收益") e.level = v;
          else if (k === "口径") e.scope = v;
        }
        continue;
      }
      const field = line.match(/^- (成本|说人话|收益|证据等级|来源|备注)[：:]\s*(.*)$/);
      if (field) {
        current = FIELDS[field[1]];
        e[current] = field[2];
      } else if (current && line.trim()) {
        e[current] += "\n" + line; // 少数条目会换行续写
      }
    }

    e.cs = (COST_W.money[e.money] ?? 0) + (COST_W.time[e.time] ?? 0) + (COST_W.will[e.will] ?? 0);
    e.ratio = ratioOf(e);
    e.dispute = /^争议/.test(e.note);
    e.todo = /待核实|TODO/.test(e.src + e.gain + e.note + e.cost);
    entries.push(e);
  }
}

// 5. 记录这份数据是哪个版本的书
const commit = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
const built = { commit, builtAt: new Date().toISOString().slice(0, 10), count: entries.length, entries };
writeFileSync(OUT, JSON.stringify(built));
console.log(`写入 ${OUT}：${entries.length} 条，书的版本 ${commit}`);
