/**
 * ZCode 输入框「增强提示词」按钮 —— 润色草稿
 * ============================================
 * 在输入框工具栏注入一个**纯图标**按钮（不显示任何文案）：
 *   点击 → 取当前草稿 → 经 preload 桥 / main handler 用**界面当前选中的模型**调一次补全 →
 *   把结果写回输入框，图标临时变成「撤销」可一键还原。
 *
 * 三种状态只靠图标 + 悬浮提示区分（不占宽度、不出现中文文本）：
 *   待机  ✦ 星芒图标   title「增强提示词」
 *   进行中 ◌ 旋转图标   title「增强中…」
 *   可还原 ↺ 撤销图标   title「恢复原文」
 *
 * 依赖：由 zcode_patcher.py --enhance-prompt 注入，配套 preload 桥（enhancePrompt）与
 *      main handler（zcode:enhance-prompt）。缺桥时按钮自动隐藏，不报错。
 *
 * 安全：只读输入框内容、只写输入框与自己的按钮；不额外发网络请求（请求在主进程侧发起）；
 *      异常静默，找不到输入框时自清理。诊断：window.__zenhanceDiag
 *
 * ★ 挂载点（1.4 修复「图标跑到输入框左上角」）：
 *   图标必须落在工具栏**右侧操作区**（与发送按钮同一组）。旧实现拿「发送按钮的父节点」当
 *   唯一锚点，取不到就退回**卡片 / dock 本体的 firstChild** —— 那两处都是输入框的祖先，
 *   等价于把图标钉在输入框左上角。而发送按钮并非恒定存在：输入框为空 + 会话进行中时，
 *   内核用「停止按钮」替换它（`sn = canStop && !hasContent`），于是图标就跑到左上角。
 *   现在改为「右侧操作区 → 发送/停止按钮父节点 → 工具栏行（贴行尾）」三级解析，
 *   任何一级都**不会**退到卡片 / dock 本体；全解析失败就保持原位、不动。
 */
(() => {
  if (window.__zenhance) return;
  window.__zenhance = true;

  const MARK = "data-zenhance";
  const BTN_ID = "zcode-enhance-prompt-btn";
  const STYLE_ID = "zenhance-style";
  const diag = (window.__zenhanceDiag = window.__zenhanceDiag || {});
  diag.scriptVersion = "1.4";

  const TIP_IDLE = "增强提示词";
  const TIP_BUSY = "增强中…";
  const TIP_REVERT = "恢复原文";
  const REVERT_WINDOW_MS = 20000;

  const COMPOSER_INPUT_SELECTORS = [
    "[data-testid='v4-composer-input']",
    "[data-testid*='composer-input']",
    "textarea[data-testid]",
    "form textarea",
    "textarea",
    "[contenteditable='true']",
  ];

  // ---------- 图标（纯 SVG，无文案） ----------
  const ICONS = {
    // 星芒：增强
    idle: '<path fill="currentColor" d="M12 2.6l1.75 4.9 4.9 1.75-4.9 1.75L12 15.9l-1.75-4.9L5.35 9.25l4.9-1.75z"/>'
      + '<path fill="currentColor" d="M18.6 14.2l.85 2.3 2.3.85-2.3.85-.85 2.3-.85-2.3-2.3-.85 2.3-.85z"/>',
    // 旋转：进行中
    busy: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.6" '
      + 'stroke-opacity="0.25"></circle>'
      + '<path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" fill="none" stroke="currentColor" stroke-width="2.6" '
      + 'stroke-linecap="round"></path>',
    // 撤销箭头：恢复原文
    revert: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
      + 'stroke-linejoin="round" d="M4.5 9.5h9a5 5 0 0 1 0 10H9"></path>'
      + '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
      + 'stroke-linejoin="round" d="M8 5.5l-3.5 4 3.5 4"></path>',
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    try {
      const st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent = [
        "#" + BTN_ID + "{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;",
        "padding:0;border-radius:8px;border:0.5px solid transparent;background:transparent;cursor:pointer;",
        "color:var(--color-foreground-subtle,#5b6470);transition:background .15s,color .15s,opacity .15s}",
        "#" + BTN_ID + ":hover{background:rgba(127,127,127,.14);color:var(--color-foreground,#1b1f24)}",
        "#" + BTN_ID + "[disabled]{opacity:.55;cursor:default}",
        "#" + BTN_ID + "[data-mode='revert']{color:var(--color-warning,#b45309)}",
        "#" + BTN_ID + " svg{width:14px;height:14px;display:block}",
        "#" + BTN_ID + " svg.zenhance-spin{animation:zenhanceSpin .9s linear infinite;transform-origin:50% 50%}",
        "@keyframes zenhanceSpin{to{transform:rotate(360deg)}}",
        ".zenhance-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483000;",
        "background:var(--color-background,#fff);color:var(--color-foreground,#1b1f24);",
        "border:1px solid rgba(127,127,127,.28);border-radius:10px;padding:8px 14px;font-size:12px;",
        "box-shadow:0 8px 24px rgba(0,0,0,.18);max-width:72vw;white-space:pre-wrap}",
      ].join("");
      document.head.appendChild(st);
    } catch (err) { /* 静默 */ }
  }

  function toast(msg, ms) {
    try {
      const old = document.querySelector(".zenhance-toast");
      if (old) old.remove();
      const el = document.createElement("div");
      el.className = "zenhance-toast";
      el.textContent = String(msg);
      document.body.appendChild(el);
      setTimeout(() => el.remove(), ms || 3600);
    } catch (err) { /* 静默 */ }
  }

  // ---------- 输入框定位 / 读写 ----------
  // ★ 关键：绝不能在整个 document 里搜「textarea / [contenteditable]」——
  //   会话消息区（timeline）里同样可能存在这类节点（消息内嵌编辑器、选区工具等），
  //   一旦命中就会被当成交互输入框，按钮随即被插进消息流里，表现为「按钮跑出输入框」。
  //   因此所有查找都先锚定到 composer dock（输入框所在的固定容器）内部。
  const DOCK_SELECTORS = [
    "[data-v4-composer-dock='true']",
    "[data-v4-composer-dock]",
    "[data-testid='v4-composer']",
  ];

  /** 取 composer dock —— 输入框与其工具栏行的最近公共容器。 */
  function findDock() {
    for (const sel of DOCK_SELECTORS) {
      let els = [];
      try { els = Array.from(document.querySelectorAll(sel)); } catch (err) { continue; }
      if (!els.length) continue;
      // 可见优先；仍以「最靠下」为准则（多会话/侧边栏场景可能有多个）
      const vis = els.filter((e) => e.offsetParent != null);
      const pool = vis.length ? vis : els;
      pool.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      return pool[0];
    }
    return null;
  }

  function findInput() {
    // ① 严格模式：只在 dock 内找输入框。找不到宁可返回 null 不动，
    //    也绝不去消息区里误抓一个元素回来。
    const dock = findDock();
    if (dock) {
      for (const sel of COMPOSER_INPUT_SELECTORS) {
        let els = [];
        try { els = Array.from(dock.querySelectorAll(sel)); } catch (err) { continue; }
        if (!els.length) continue;
        const vis = els.filter((e) => e.offsetParent != null);
        const pool = vis.length ? vis : els;
        pool.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        return pool[0];
      }
    }
    // ② 兼容模式：dock 锚点不存在才退回全局，但仅认「带明确 composer 语义」的选择器，
    //    不含 textarea / [contenteditable] 这类会误伤消息区的通用选择器。
    for (const sel of COMPOSER_INPUT_SELECTORS) {
      if (sel === "textarea" || sel === "[contenteditable='true']" || sel === "form textarea") continue;
      let els = [];
      try { els = Array.from(document.querySelectorAll(sel)); } catch (err) { continue; }
      if (!els.length) continue;
      const vis = els.filter((e) => e.offsetParent != null);
      const pool = vis.length ? vis : els;
      pool.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      return pool[0];
    }
    return null;
  }

  function readText(el) {
    if (!el) return "";
    if (typeof el.value === "string") return el.value;
    return el.innerText || el.textContent || "";
  }

  /** 写回受控输入框：优先 execCommand('insertText')（textarea 与 contenteditable 都能触发
   *  React 受控更新），失败退回「原生 setter + input 事件」。 */
  function writeText(el, text) {
    if (!el) return false;
    try { el.focus(); } catch (err) { /* ignore */ }
    try {
      if (typeof el.select === "function") el.select();
      else if (typeof el.setSelectionRange === "function") el.setSelectionRange(0, readText(el).length);
      else {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (document.execCommand && document.execCommand("insertText", false, text)) return true;
    } catch (err) { /* 落到兜底 */ }
    try {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : (el instanceof HTMLInputElement ? HTMLInputElement.prototype : null);
      const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, text);
      else el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    } catch (err) {
      return false;
    }
  }

  /** 当前选中的模型：模型按钮就挂在 composer 工具栏上，因此先锚定 dock 再找
   *  [data-model-current-value]（形如 providerId/modelId）。
   *  ★ 修复：旧实现全局搜 + 「最靠下」启发式会稳定失灵——输入框工具栏位于
   *  fixed 定位容器内，offsetParent 恒为 null 被「可见过滤」整批误杀；而后台
   *  残留的设置/工作流面板节点反而「更靠下」被取走（或整池为空），于是
   *  mv/ml 恒为空 → 主进程四档解析全空 → 掉进兜底档，把请求发给供应商表里
   *  第一个可用供应商的第一个模型。典型表现：报错里的模型不是你选的那个。 */
  function currentModel() {
    let value = "", label = "";
    try {
      const dock = findDock();
      let pool = [];
      if (dock) pool = Array.from(dock.querySelectorAll("[data-model-current-value]"));
      if (!pool.length) {
        // dock 内没有（极端布局）才退回全局，但排除工作流运行设置等面板的残留节点
        pool = Array.from(document.querySelectorAll("[data-model-current-value]"))
          .filter((e) => !e.closest("[data-testid='workflow-run-settings-model']"));
      }
      if (pool.length) {
        const vis = pool.filter((e) => e.offsetParent != null);
        // dock 命中时不再因 offsetParent=null 丢弃：fixed 容器里该属性本就恒为 null
        const usablePool = (dock && pool.length) ? pool : (vis.length ? vis : pool);
        usablePool.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        const el = usablePool[0];
        value = String(el.getAttribute("data-model-current-value") || "").trim();
        // 显示名取该节点里最长的可见文本（模型名 + 可能的连接方式后缀）
        const t = String(el.textContent || "").replace(/\s+/g, " ").trim();
        label = t;
        diag.modelCandidates = pool.length;
      }
    } catch (err) { /* ignore */ }
    return { value, label };
  }

  // ---------- 挂载点解析 ----------
  // 客户端 composer 工具栏的真实结构（3.14.3，out/renderer 实证）：
  //
  //   div[data-testid='v4-composer']                ← 卡片 = 输入框所在区域(.chat-composer-region)
  //    └─ div.chat-composer-input-surface
  //       └─ div.group/toolbar.flex.items-end.gap-3 ← 工具栏行
  //          ├─ div[data-composer-leading-actions]      ← 左侧（+ / 附件）
  //          └─ div[data-composer-trailing-actions]     ← ★ 右侧操作区（恒存在）
  //             └─ div.flex.min-w-0.items-center.gap-1  ← 提交控件容器
  //                ├─ span …                              ← 模型胶囊
  //                └─ button[data-testid='v4-composer-send'] ← 发送
  //
  // ★ 发送按钮不是恒定锚点：**输入框为空 + 会话进行中**时，内核用
  //   button[data-testid='v4-stop']（停止）替换它（sn = canStop && !hasContent）。
  //   旧实现只认 v4-composer-send，取不到就退回卡片/dock 的 firstChild —— 那正是
  //   输入框左上角，于是「输入框为空」和「会话进行中」两种情况下图标都会跑到左上角。
  const CARD_SELECTOR = "[data-testid='v4-composer']";
  const TRAILING_SELECTOR = "[data-composer-trailing-actions]";
  const ANCHOR_BUTTON_SELECTORS = [
    "[data-testid='v4-composer-send']",
    "[data-testid='v4-stop']",
  ];

  /** 输入框所在的 composer 卡片（.chat-composer-region）；找不到才退回 dock。 */
  function findCard(input, dock) {
    let card = null;
    try { card = input && input.closest(CARD_SELECTOR); } catch (err) { /* ignore */ }
    if (!card && dock) {
      try { card = dock.querySelector(CARD_SELECTOR); } catch (err) { /* ignore */ }
    }
    return card || dock || null;
  }

  /** 工具栏行：class 同时含 flex 与 items-end 的 div（与 TPS 状态栏同一套结构判定，
   *  不依赖任何会随版本/语言变化的文案）。 */
  function findToolbarRow(card) {
    if (!card) return null;
    let rows = [];
    try {
      rows = Array.from(card.querySelectorAll("div")).filter((el) => {
        const c = typeof el.className === "string" ? el.className : "";
        return /(^|\s)flex(\s|$)/.test(c) && /items-end/.test(c);
      });
    } catch (err) { /* ignore */ }
    if (!rows.length) return null;
    return rows.find((el) => el.querySelector("button,select,[role='combobox'],input"))
        || rows[rows.length - 1];
  }

  /** 解析挂载点，返回 { host, where }：where = "prepend"（右侧操作区，与发送按钮同组）
   *  或 "append"（兜底工具栏行，贴行尾）。host 为 null = 解析失败。
   *  ★ 任何一级都**不得**退到卡片 / dock 本体：它们是输入框的祖先，往其 firstChild
   *    插入就等于把图标钉在输入框左上角（本次要修的 bug）。 */
  function findMount(input, dock) {
    const card = findCard(input, dock);
    // ① 首选：右侧操作区 —— 唯一跨状态恒存在的锚点（发送/停止按钮都在它内部）
    let host = null;
    if (card) {
      try { host = card.querySelector(TRAILING_SELECTOR); } catch (err) { /* ignore */ }
    }
    if (host) return { host, where: "prepend" };
    // ② 次选：发送 / 停止按钮的父节点（两者同属一个提交控件容器）。
    //    先在 card 内查，避免多会话/多 composer 时抓到别的卡片的按钮。
    for (const sel of ANCHOR_BUTTON_SELECTORS) {
      let el = null;
      if (card) {
        try { el = card.querySelector(sel); } catch (err) { /* ignore */ }
      }
      if (!el) {
        try { el = document.querySelector(sel); } catch (err) { /* ignore */ }
      }
      if (el && el.parentElement && (!card || card.contains(el))) {
        return { host: el.parentElement, where: "prepend" };
      }
    }
    // ③ 末选：工具栏行 —— 追加到**行尾**（右端），绝不插行首（= 输入框左侧/左上角）
    const row = findToolbarRow(card);
    if (row) return { host: row, where: "append" };
    return { host: null, where: null };
  }

  /** 落位：prepend = 图标落在模型胶囊/发送按钮**左侧**（即既有正确位置）；
   *  append 仅用于兜底工具栏行。 */
  function place(el, host, where) {
    if (where === "append") host.appendChild(el);
    else host.insertBefore(el, host.firstChild);
  }

  // ---------- 按钮 ----------
  let btn = null;
  let busy = false;
  let original = null;
  let revertTimer = null;

  function setButton(mode) {
    if (!btn) return;
    const tip = mode === "busy" ? TIP_BUSY : (mode === "revert" ? TIP_REVERT : TIP_IDLE);
    btn.setAttribute("data-mode", mode);
    btn.setAttribute("title", tip);
    btn.setAttribute("aria-label", tip);
    btn.disabled = busy;
    btn.innerHTML = "";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (mode === "busy") svg.setAttribute("class", "zenhance-spin");
    svg.innerHTML = ICONS[mode] || ICONS.idle;
    btn.appendChild(svg);
  }

  function armRevert() {
    clearTimeout(revertTimer);
    setButton("revert");
    revertTimer = setTimeout(() => {
      original = null;
      setButton("idle");
    }, REVERT_WINDOW_MS);
  }

  async function enhance() {
    const el = findInput();
    if (!el) { toast("没找到输入框"); return; }
    const text = readText(el).trim();
    if (!text) { toast("请先输入要增强的内容"); return; }

    const api = window.zcode;
    if (!api || typeof api.enhancePrompt !== "function") {
      toast("通信桥不可用：请重跑 --enhance-prompt 注入后重启 ZCode");
      return;
    }

    busy = true;
    setButton("busy");
    const m = currentModel();
    diag.lastRequest = { modelValue: m.value, modelLabel: m.label, chars: text.length };
    try {
      const res = await api.enhancePrompt(text, m.value, m.label);
      diag.lastResult = res && res.success
        ? { model: res.model, provider: res.provider, how: res.how, chars: String(res.text || "").length }
        : { code: (res && res.code) || "unknown", error: String((res && res.error) || "未知错误") };
      if (!res || !res.success) {
        // 「模型不可用」是配置问题，不是网络问题 —— 给出可执行的下一步，而不是甩一个 HTTP 400
        const tip = String((res && res.tip) || "");
        const head = "增强失败：" + String((res && res.error) || "未知错误");
        const body = tip ? ("\n→ " + tip) : "";
        toast(head + body, tip ? 9000 : 5200);
        if (res && (res.code === "model" || res.code === "auth" || res.code === "no-model")) {
          console.warn("[zcode-enhance] 配置类失败", res);
        }
        return;
      }
      const enhanced = String(res.text || "").trim();
      if (!enhanced) { toast("增强失败：模型返回空内容", 5200); return; }
      original = text;
      if (!writeText(el, enhanced)) {
        toast("已生成结果但写回输入框失败，请手动复制：\n" + enhanced.slice(0, 200), 8000);
        return;
      }
      armRevert();
      toast("已用「" + (res.model || "当前模型") + "」增强");
    } catch (err) {
      diag.lastResult = { code: "exception", error: String(err) };
      toast("增强异常：" + String((err && err.message) || err), 5200);
    } finally {
      busy = false;
      if (btn) {
        if (btn.getAttribute("data-mode") === "revert") btn.disabled = false;
        else setButton("idle");
      }
    }
  }

  function onRevert() {
    const el = findInput();
    if (el && original != null) writeText(el, original);
    original = null;
    clearTimeout(revertTimer);
    setButton("idle");
  }

  function ensureButton() {
    ensureStyle();
    const input = findInput();
    if (!input) { if (btn) { btn.remove(); btn = null; } diag.hiddenReason = "未找到输入框"; return; }

    // ★ 挂载点 = 工具栏「右侧操作区」（与发送按钮同一组），见 findMount()。
    //   绝不再退回卡片 / dock 本体：那是输入框的祖先，往其 firstChild 插入
    //   就等于把图标钉在输入框左上角（历史 bug：输入框为空 / 会话进行中）。
    const dock = findDock();
    const mount = findMount(input, dock);
    const host = mount.host;
    if (!host) {
      // 解析不到操作区：保持现状，绝不搬到左上角。从未挂上过才允许下次重试。
      diag.hiddenReason = "未找到工具栏操作区";
      if (btn && !btn.isConnected) btn = null;
      return;
    }
    diag.hiddenReason = null;
    diag.mountWhere = mount.where;

    if (btn && btn.isConnected) {
      // ★ 位置自愈：按钮虽还在文档里，但已不在正确容器内（客户端重渲染把按钮
      //   连同旧节点一起搬走 / 被消息列表的 DOM 复用吞掉）→ 主动搬回来。
      const okPlace = btn.parentElement === host;
      const stillInDock = !dock || dock.contains(btn);
      if (!okPlace || !stillInDock) {
        diag.reattaches = (diag.reattaches || 0) + 1;
        place(btn, host, mount.where);
      }
      return;
    }
    btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.setAttribute(MARK, "1");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      if (btn.getAttribute("data-mode") === "revert") onRevert();
      else enhance();
    });
    place(btn, host, mount.where);
    setButton("idle");
    diag.buttonAttached = true;
  }

  function start() {
    ensureStyle();
    let timer = null;
    // 抖动：DOM 变动很密集（流式输出时每帧都在改），300ms 合并一次足够；
    // 且 ensureButton() 内部只在「位置不对」时才真正写 DOM，不会引起抖动循环。
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; if (!document.hidden) ensureButton(); }, 300);
    };
    try {
      // ★ 只监听 dock 所在的子树 + 顶层结构变化，避免被消息流每帧刷新增量拖慢；
      //   订阅 childList 即可——按钮错位总是源于节点被移动/替换。
      new MutationObserver(schedule).observe(document.body, {
        childList: true, subtree: true,
      });
    } catch (err) { /* 静默 */ }
    // 兜底轮询：即使 MutationObserver 漏事件（如纯 style 变更导致的 sticky 失效），
    // 也能在一个短周期内把按钮搬回正确位置。
    setInterval(() => { if (!document.hidden) ensureButton(); }, 1000);
    ensureButton();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);

  setTimeout(() => {
    if (!diag.buttonAttached) console.warn("[zcode-enhance] 按钮未挂载，window.__zenhanceDiag =", diag);
    else console.info("[zcode-enhance] 已就绪，window.__zenhanceDiag =", diag);
  }, 5000);
})();
