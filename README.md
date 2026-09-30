# 生活顾问

给家里人用的问答网页。手机上打开，问一句「有人推销保健品，买不买」，它会先去《高性价比人生指南》里查相关条目，再按书里的算账方式回答，每条注明出自第几节第几条。

书的内容来自 [eternity4719/HowToLiveBetter](https://github.com/eternity4719/HowToLiveBetter)（CC BY 4.0），回答规则改编自作者提供的 [life-decision-guide skill](https://github.com/eternity4719/HowToLiveBetter/tree/main/skills/life-decision-guide)。

## 它是怎么工作的

```
手机网页  ──问题──▶  Cloudflare 上的小程序  ──关键词检索──▶  entries.json（641 条）
                            │
                            └──相关的 12 条 + 回答规则──▶  DeepSeek  ──流式回答──▶  手机
```

- `public/index.html` 是网页本身，大字号，适合长辈。
- `public/entries.json` 是把书拆好的条目库，由 `scripts/build-entries.mjs` 从原书生成，性价比档位直接沿用原书 `index.html` 里的算法。
- `functions/api/ask.js` 在 Cloudflare 上运行：检索条目，拼上规则，调用 DeepSeek，把回答转给网页。密钥只存在这里。
- `.github/workflows/update-book.yml` 每周一自动拉一次最新的书并重新生成条目库。

## 部署（一次性，大约 20 分钟）

### 1. 拿一个 DeepSeek 密钥

去 platform.deepseek.com 注册，充值 10 元就够用很久（一次问答大约几分钱）。在 API keys 页面新建一个密钥，复制保存。

### 2. 把这个项目推到 GitHub

```bash
cd family-guide
node scripts/build-entries.mjs        # 生成最新的 entries.json
git init
git add .
git commit -m "Add family life guide"
gh repo create family-guide --private --source=. --push
```

### 3. 在 Cloudflare 上部署

1. 注册 cloudflare.com（免费）。
2. 左侧 **Workers & Pages** → **Create** → **Pages** → **Connect to Git**，选 `family-guide` 仓库。
3. Build settings：Framework preset 选 **None**，Build command 留空，Build output directory 填 `public`。
4. 点 **Save and Deploy**。
5. 部署完成后进入项目的 **Settings** → **Variables and Secrets**，添加两个 Secret：
   - `DEEPSEEK_API_KEY`：第 1 步的密钥
   - `ACCESS_CODE`：自己定一个口令，比如 `mama2026`，家人第一次打开时要输
6. 回到 **Deployments**，点最新一次部署右边的 **Retry deployment**，让环境变量生效。

网址是 `https://family-guide-xxx.pages.dev`。想要好记的地址，可以在 Cloudflare 里绑一个自己的域名。

### 4. 给爸妈

把网址发给他们，让他们用手机浏览器打开，输入口令。然后

- iPhone：Safari 底部分享按钮 → **添加到主屏幕**
- 安卓：浏览器菜单 → **添加到桌面**

以后就像一个 App 一样点开用。

## 日常维护

- 书更新了不用管，每周一自动同步。想立刻更新，去仓库的 **Actions** 页面手动运行一次 **Update book entries**。
- DeepSeek 余额在 platform.deepseek.com 看，快用完了充一下。
- 换口令：改 Cloudflare 里的 `ACCESS_CODE`，重新部署，家人下次打开重新输一次。
- 想换别的模型，改环境变量 `MODEL` 和 `UPSTREAM_URL`，只要是兼容 OpenAI 接口格式的都行（通义、Kimi、智谱等）。

## 本地测试

```bash
node scripts/build-entries.mjs
npm install -g wrangler
echo 'DEEPSEEK_API_KEY=你的密钥' > .dev.vars
echo 'ACCESS_CODE=1234' >> .dev.vars
wrangler pages dev public
```

打开 http://localhost:8788 。

## 边界

这个工具只转述书里的内容，书的观点是作者的。它不替代医生、律师和会计。急症先打 120。
