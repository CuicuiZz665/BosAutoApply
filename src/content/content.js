// content.js
// 运行在 BOSS 直聘职位搜索页 (https://www.zhipin.com/web/geek/job*) 上，
// 负责实际的"搜索匹配职位 -> 打招呼 -> 投递"自动化流程。
//
// 设计要点：
// - 完全基于当前已登录的页面 DOM 操作，不读取、不上传任何账号 / Cookie 信息。
// - 状态保存在本脚本内的一个模块级对象里，独立于 popup 是否打开，
//   进度通过 chrome.runtime.sendMessage 上报给 background，
//   popup 打开时向 background 拉取最新状态即可，即使中途关闭 popup 也不会丢进度。
// - 所有涉及"下一步"的地方都做了轮询等待（waitFor），并且每一步都会检查
//   是否被用户点了"停止"，保证可以及时中断。

(function () {
  const SEL = window.__BOSS_SELECTORS__ || (typeof BOSS_SELECTORS !== 'undefined' ? BOSS_SELECTORS : null);
  const MATCH = typeof matchJob !== 'undefined' ? matchJob : null;
  const PARSE_SALARY = typeof parseSalaryRange !== 'undefined' ? parseSalaryRange : null;

  const state = {
    running: false,
    appliedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    log: [],
    config: null,
    stopRequested: false
  };

  const STORAGE_KEY_SEEN = 'ba_seen_job_ids';

  function log(message, level = 'info') {
    const entry = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), message, level };
    state.log.push(entry);
    if (state.log.length > 300) state.log.shift();
    reportProgress();
    // eslint-disable-next-line no-console
    console.log(`[BOSS自动投递] ${entry.time} ${message}`);
  }

  function reportProgress() {
    chrome.runtime.sendMessage({
      type: 'BA_PROGRESS',
      payload: {
        running: state.running,
        appliedCount: state.appliedCount,
        skippedCount: state.skippedCount,
        errorCount: state.errorCount,
        log: state.log.slice(-50)
      }
    }).catch(() => {});
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomDelay(minMs, maxMs) {
    const lo = Math.max(300, minMs || 3000);
    const hi = Math.max(lo, maxMs || 8000);
    return lo + Math.random() * (hi - lo);
  }

  async function waitFor(conditionFn, { timeout = 8000, interval = 200 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (state.stopRequested) return null;
      const result = conditionFn();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  function queryFirst(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function queryAllFirst(root, selectors) {
    for (const sel of selectors) {
      const els = root.querySelectorAll(sel);
      if (els && els.length > 0) return Array.from(els);
    }
    return [];
  }

  function findByText(root, tagSelector, textIncludesList) {
    const candidates = Array.from(root.querySelectorAll(tagSelector));
    return candidates.find((el) => {
      const t = (el.textContent || '').trim();
      return textIncludesList.some((needle) => t.includes(needle));
    }) || null;
  }

  function getJobCards() {
    const container = queryFirst(document, SEL.jobListContainer) || document.body;
    return queryAllFirst(container, SEL.jobCard);
  }

  function buildJobId(href, title, company, salary) {
    // 职位详情链接通常带有 lid / securityId 等每次搜索都会变化的追踪参数，
    // 必须只取路径部分作为稳定 ID，否则同一个职位每次搜索都会被当成"新职位"，
    // 导致重复打招呼。
    if (href) {
      try {
        const url = new URL(href, window.location.href);
        if (url.pathname && url.pathname !== '/') return url.pathname;
      } catch (e) {
        // 不是合法 URL，走兜底方案
      }
    }
    return `${title}__${company}__${salary}`;
  }

  function extractJobInfo(card) {
    const titleEl = queryFirst(card, SEL.jobTitle);
    const companyEl = queryFirst(card, SEL.companyName);
    const salaryEl = queryFirst(card, SEL.jobSalary);
    const tagsEls = queryAllFirst(card, SEL.jobTags);
    const linkEl = card.querySelector('a[href]');

    const title = titleEl ? titleEl.textContent.trim() : '';
    const company = companyEl ? companyEl.textContent.trim() : '';
    const salary = salaryEl ? salaryEl.textContent.trim() : '';
    const areaEl = queryFirst(card, SEL.jobArea);
    const area = areaEl ? areaEl.textContent.trim() : '';
    const descEl = queryFirst(card, SEL.jobDesc);
    const jobDesc = descEl ? descEl.textContent.trim() : '';
    const tagsText = tagsEls.map((el) => el.textContent.trim()).join(' ');
    const href = linkEl ? linkEl.getAttribute('href') : '';

    const jobId = buildJobId(href, title, company, salary);

    return { jobId, title, company, salary, area, jobDesc, tagsText };
  }

  async function loadSeenIds() {
    const data = await chrome.storage.local.get(STORAGE_KEY_SEEN);
    return new Set(data[STORAGE_KEY_SEEN] || []);
  }

  async function markSeen(jobId) {
    const data = await chrome.storage.local.get(STORAGE_KEY_SEEN);
    const list = data[STORAGE_KEY_SEEN] || [];
    if (!list.includes(jobId)) {
      list.push(jobId);
      if (list.length > 5000) list.splice(0, list.length - 5000);
      await chrome.storage.local.set({ [STORAGE_KEY_SEEN]: list });
    }
  }

  function setNativeValue(element, value) {
    const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 逐字符"打字"，而不是一次性把整段文字塞进输入框，这样在页面上能看到文字
  // 一个字一个字冒出来，也顺带让单次操作耗时更接近真人手速。
  async function typeLikeHuman(element, text) {
    setNativeValue(element, '');
    await sleep(randomDelay(200, 400));
    let current = '';
    for (const ch of text) {
      if (state.stopRequested) return;
      current += ch;
      setNativeValue(element, current);
      await sleep(30 + Math.random() * 70);
    }
    await sleep(randomDelay(300, 600));
  }

  // 给即将点击的元素画一圈短暂的高亮框，方便肉眼看到插件正在点哪个按钮。
  function highlightElement(el, duration = 900) {
    if (!el || !el.style) return;
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '2px solid #ff4757';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, duration);
  }

  // BOSS 页面里不少"按钮"其实是 <a href="javascript:;"> 链接。真人点击时页面
  // 自有 CSP 放行无影响；但 content script 触发的点击（无论 el.click() 还是
  // 派发合成 MouseEvent）都会让 Chrome 以扩展的 CSP 去执行该 javascript: 地址，
  // 被 MV3 默认策略拦截并在扩展页记一条 CSP 错误（点击监听器仍会执行，功能
  // 不受影响，但错误面板会被刷屏）。
  // 正确解法：派发"可取消"的合成 click，并挂一个临时监听器把它取消——
  // 页面框架的 click 监听器照常收到事件，而锚点执行 javascript: 的默认
  // 行为被抑制，不产生 CSP 违规。仅取消非可信事件，不干扰真实用户点击。
  function syntheticClick(el) {
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      clientX: Math.max(rect.left + rect.width / 2, 0),
      clientY: Math.max(rect.top + rect.height / 2, 0)
    };
    const cancelSynthetic = (e) => {
      if (!e.isTrusted) e.preventDefault();
    };
    el.addEventListener('click', cancelSynthetic);
    try {
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    } finally {
      el.removeEventListener('click', cancelSynthetic);
    }
  }

  // 沿祖先链查找 <a href="javascript:...">：点击目标常是按钮内部的 span 等子元素，
  // el.click() 的默认动作会跟随最近的 javascript: 链接祖先，同样触发 CSP 报错，
  // 所以不能只看元素本身是不是 javascript: 链接。
  function hasJsUrlAnchorAncestor(el) {
    let node = el;
    while (node && node !== document.body && node.nodeType === 1) {
      if (node.tagName === 'A' && /^javascript:/i.test(node.getAttribute('href') || '')) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  // 统一的"人类式点击"：平滑滚动到元素可见位置，停顿一下，高亮，再停顿一下，
  // 最后才点击——让每一步操作在页面上都清晰可辨，而不是瞬间完成看不出发生了什么。
  async function humanClick(el) {
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(randomDelay(400, 900));
    if (state.stopRequested) return false;
    highlightElement(el);
    await sleep(randomDelay(250, 600));
    if (state.stopRequested) return false;
    if (hasJsUrlAnchorAncestor(el)) {
      // 元素自身或其祖先链上是 javascript: 链接 → 用合成鼠标事件，
      // 避免 el.click() 跟随 javascript: 地址触发 CSP 报错
      syntheticClick(el);
    } else {
      el.click();
    }
    await sleep(randomDelay(200, 500));
    return true;
  }

  function isCardAlreadyChatted(card) {
    const text = card.textContent || '';
    return SEL.alreadyChattedTextHints.some((hint) => text.includes(hint));
  }

  async function performSearch(keyword) {
    const input = await waitFor(() => queryFirst(document, SEL.searchInput), { timeout: 5000 });
    if (!input) {
      log('未找到页面搜索框，将直接使用当前页面已有的职位列表（如需按关键词搜索，请先手动在 BOSS 搜索框中搜索）', 'warn');
      return false;
    }

    await humanClick(input);
    input.focus();
    await typeLikeHuman(input, keyword);

    const searchBtn = queryFirst(document, SEL.searchButton);
    if (searchBtn) {
      await humanClick(searchBtn);
    } else {
      await sleep(randomDelay(200, 500));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }

    const ok = await waitFor(() => getJobCards().length > 0, { timeout: 8000 });
    if (!ok) {
      log(`搜索「${keyword}」后未加载出职位列表，请确认关键词是否有结果`, 'warn');
      return false;
    }
    await sleep(800);
    return true;
  }

  async function applySalaryFilter(minK, maxK) {
    if (!minK && !maxK) return; // 用户没设置薪资范围，保持"不限"
    if (!PARSE_SALARY) return;

    const trigger = findByText(document, 'div, span, button, a', SEL.salaryFilterTriggerTexts);
    if (!trigger) {
      log('未找到"薪资待遇"筛选按钮，跳过原生筛选设置（仍会按薪资对已加载的结果做二次过滤）', 'warn');
      return;
    }

    await humanClick(trigger);

    const panel = await waitFor(() => queryFirst(document, SEL.filterDropdownPanel), { timeout: 3000 }) || document;
    const optionEls = queryAllFirst(panel, SEL.filterOptionItem).filter((el) => (el.textContent || '').trim());

    const lo = minK || 0;
    const hi = maxK || Infinity;
    let bestEl = null;
    let bestOverlap = -Infinity;
    for (const el of optionEls) {
      const range = PARSE_SALARY(el.textContent.trim());
      if (!range) continue;
      const overlap = Math.min(range.max, hi) - Math.max(range.min, lo);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestEl = el;
      }
    }

    if (!bestEl) {
      log('未能在薪资筛选选项里找到可解析的档位，跳过原生筛选设置', 'warn');
      await humanClick(trigger); // 尝试收起面板
      return;
    }

    const chosenText = bestEl.textContent.trim();
    await humanClick(bestEl);

    const confirmBtn = findByText(document, 'button, span, a', SEL.filterConfirmButtonTexts);
    if (confirmBtn) await humanClick(confirmBtn);

    await waitFor(() => getJobCards().length > 0, { timeout: 6000 });
    log(`已应用薪资筛选：${chosenText}`);
  }

  // 把用户设置的一组值勾选到 BOSS 原生多选筛选上（区域/行业共用），再点确定。
  // 输入"海淀"这类简称也能命中"海淀区"选项（包含匹配）；
  // 个别值没找到只记 warn 不中断，全部没找到则保持"不限"。
  async function applyMultiSelectFilter(triggerTexts, values, filterLabel) {
    if (!values || values.length === 0) return; // 用户没填，保持"不限"

    const trigger = findByText(document, 'div, span, button, a', triggerTexts);
    if (!trigger) {
      log(`未找到"${filterLabel}"筛选按钮，跳过原生筛选${filterLabel === '区域' ? '（仍会对卡片上的区域文字做二次过滤）' : ''}`, 'warn');
      return;
    }

    await humanClick(trigger);
    const panel = await waitFor(() => queryFirst(document, SEL.filterDropdownPanel), { timeout: 3000 }) || document;

    const applied = [];
    const missing = [];
    for (const name of values) {
      // 每次勾选后面板可能重新渲染，逐个重新收集选项更稳
      const optionEls = queryAllFirst(panel, SEL.filterOptionItem).filter((el) => (el.textContent || '').trim());
      const target =
        optionEls.find((el) => el.textContent.trim() === name) ||
        optionEls.find((el) => el.textContent.trim().includes(name));
      if (!target) {
        missing.push(name);
        continue;
      }
      await humanClick(target);
      applied.push(target.textContent.trim());
      await sleep(randomDelay(200, 450));
    }

    if (applied.length === 0) {
      log(`"${filterLabel}"筛选里没有找到「${values.join('、')}」中的任何一项，保持不限`, 'warn');
      await humanClick(trigger); // 尝试收起面板
      return;
    }

    const confirmBtn = findByText(document, 'button, span, a', SEL.filterConfirmButtonTexts);
    if (confirmBtn) await humanClick(confirmBtn);

    await waitFor(() => getJobCards().length > 0, { timeout: 6000 });
    log(`已应用"${filterLabel}"筛选：${applied.join('、')}${missing.length ? `（未找到：${missing.join('、')}）` : ''}`);
  }

  async function selectDropdownFilterByText(triggerTexts, desiredText, filterLabel) {
    if (!desiredText) return; // "不限"，不调整

    const trigger = findByText(document, 'div, span, button, a', triggerTexts);
    if (!trigger) {
      log(`未找到"${filterLabel}"筛选按钮，跳过`, 'warn');
      return;
    }

    // 页面上该筛选已经是目标值（比如你手动设置过）时，无需重复设置
    if ((trigger.textContent || '').includes(desiredText)) {
      log(`"${filterLabel}"已是「${desiredText}」，无需设置`);
      return;
    }

    await humanClick(trigger);

    const panel = await waitFor(() => queryFirst(document, SEL.filterDropdownPanel), { timeout: 3000 }) || document;
    const optionEls = queryAllFirst(panel, SEL.filterOptionItem).filter((el) => (el.textContent || '').trim());

    const target =
      optionEls.find((el) => el.textContent.trim() === desiredText) ||
      optionEls.find((el) => el.textContent.trim().includes(desiredText));

    if (!target) {
      log(`"${filterLabel}"筛选选项里没有找到「${desiredText}」，跳过（可能选项文案与页面实际不一致，可在 selectors.js 里核对）`, 'warn');
      await humanClick(trigger);
      return;
    }

    await humanClick(target);

    const confirmBtn = findByText(document, 'button, span, a', SEL.filterConfirmButtonTexts);
    if (confirmBtn) await humanClick(confirmBtn);

    await waitFor(() => getJobCards().length > 0, { timeout: 6000 });
    log(`已应用"${filterLabel}"筛选：${desiredText}`);
  }

  // 清掉可能挡在流程中间的通用弹窗（完善简历提示、活动广告等）。
  // 专门处理"已向BOSS发送消息"确认框的逻辑在 sendGreeting 里，这里只处理其余的。
  async function dismissGenericDialog() {
    const closeBtn = findByText(document, 'button, span, a, i, div', SEL.genericDialogCloseTexts);
    if (closeBtn) {
      await humanClick(closeBtn);
      return true;
    }
    const closeIcon = queryFirst(document, SEL.genericDialogCloseIconSelectors);
    if (closeIcon) {
      await humanClick(closeIcon);
      return true;
    }
    return false;
  }

  async function openChatForCard(card) {
    // 优先尝试卡片上直接可见的"打招呼/立即沟通"按钮
    let chatBtn = queryFirst(card, SEL.cardChatButton) || findByText(card, 'button, a, span', ['打招呼', '立即沟通', '沟通']);

    if (!chatBtn) {
      // 退而求其次：点击卡片本身，唤出详情面板，再在详情面板里找按钮
      await humanClick(card);
      await sleep(randomDelay(400, 800));
      const detailRoot = document;
      chatBtn = findByText(detailRoot, 'button, a, span', ['打招呼', '立即沟通']);
    }

    if (!chatBtn) return false;

    await humanClick(chatBtn);
    return true;
  }

  function findAutoSentDialogButtons() {
    const hasDialogText = SEL.autoSentDialogHints.some((hint) => document.body.textContent.includes(hint));
    if (!hasDialogText) return null;
    const stayBtn = findByText(document, 'button, span, a, div', SEL.autoSentDialogStayButtonTexts);
    const continueBtn = findByText(document, 'button, span, a, div', SEL.autoSentDialogContinueButtonTexts);
    if (!stayBtn && !continueBtn) return null;
    return { stayBtn, continueBtn };
  }

  // 在聊天输入框里逐字输入话术并发送（成功返回 true）
  async function typeAndSendGreeting(input, text) {
    await humanClick(input);
    await typeLikeHuman(input, text);
    const sendBtn = queryFirst(document, SEL.chatSendButton) || findByText(document, 'button, span, div', ['发送']);
    if (sendBtn) {
      await humanClick(sendBtn);
    } else {
      // 回退方案：模拟回车发送
      await sleep(randomDelay(200, 500));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }
  }

  // 尝试关闭聊天弹层/面板，回到职位列表继续
  async function closeChatPanel() {
    const panel = queryFirst(document, SEL.chatDialog);
    const closeBtn = panel ? queryFirst(panel, SEL.genericDialogCloseIconSelectors) : queryFirst(document, SEL.genericDialogCloseIconSelectors);
    if (closeBtn) {
      await humanClick(closeBtn);
      await sleep(400);
      return;
    }
    // 没找到关闭按钮时用 ESC 兜底
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(400);
  }

  async function sendGreeting(greetingText) {
    // 点击"打招呼"后，BOSS 可能出现两种情况，谁先出现处理谁：
    // 1) 一个可编辑的聊天输入框 —— 我们填入自定义话术并发送；
    // 2) 一个"已向BOSS发送消息"确认框 —— BOSS 已经用你在官方设置里配置的
    //    默认招呼语直接发出去了。此时若配置了自定义话术，会尝试点"继续沟通"
    //    打开聊天面板，把自定义话术作为第二条消息补发（默认招呼语无法阻止或
    //    替换，这是平台机制）；补发失败则仅确认弹窗、继续下一个职位。
    const outcome = await waitFor(() => {
      const input = queryFirst(document, SEL.chatInput);
      if (input) return { type: 'input', input };
      const dialog = findAutoSentDialogButtons();
      if (dialog) return { type: 'auto-sent', dialog };
      return null;
    }, { timeout: 6000 });

    if (!outcome) {
      return { ok: false, reason: '未找到聊天输入框，也没有检测到发送确认弹窗（可能页面结构已变化，或该职位需要先完善简历）' };
    }

    if (outcome.type === 'auto-sent') {
      let appended = false;
      if (greetingText && outcome.dialog.continueBtn) {
        await humanClick(outcome.dialog.continueBtn);
        const input = await waitFor(() => queryFirst(document, SEL.chatInput), { timeout: 5000 });
        if (input) {
          try {
            await typeAndSendGreeting(input, greetingText);
            appended = true;
            await sleep(randomDelay(500, 1000));
            await closeChatPanel();
          } catch (_e) {
            appended = false;
          }
        }
        if (!appended) {
          // 补发失败：确认框可能还开着（点了"继续沟通"没打开面板），关掉它继续
          const dialogAgain = findAutoSentDialogButtons();
          if (dialogAgain) {
            const b = dialogAgain.stayBtn || dialogAgain.continueBtn;
            if (b) await humanClick(b);
          }
        }
      } else {
        const btn = outcome.dialog.stayBtn || outcome.dialog.continueBtn;
        await humanClick(btn);
      }
      return { ok: true, usedDefaultGreeting: !appended, appendedGreeting: appended };
    }

    await typeAndSendGreeting(outcome.input, greetingText);
    return { ok: true };
  }

  // 加载更多职位，兼容两种页面形态：
  // 1) 传统分页：存在"下一页"按钮时点击翻页（老版页面）；
  // 2) 无限滚动（新版页面）：平滑滚动到列表底部触发加载，等待新卡片出现。
  //    两次尝试后卡片数量仍无增长，则认为已经到底、没有更多职位。
  async function loadMoreJobs() {
    // 模式1：传统分页按钮
    const nextBtn = queryFirst(document, SEL.nextPageButton);
    if (nextBtn) {
      const isDisabled = nextBtn.classList.contains('disabled') || nextBtn.getAttribute('aria-disabled') === 'true';
      if (isDisabled) return false;
      await humanClick(nextBtn);
      await sleep(1500);
      return true;
    }

    // 模式2：无限滚动加载
    const before = getJobCards().length;

    const scrollToBottom = async () => {
      // 同时滚动列表容器和窗口：不同布局下触发加载的滚动源不一样
      const containers = [
        queryFirst(document, SEL.jobListContainer),
        document.scrollingElement
      ].filter(Boolean);
      for (const el of containers) {
        try {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        } catch (_e) {
          el.scrollTop = el.scrollHeight; // 平滑滚动不生效时的兜底
        }
      }
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      await scrollToBottom();
      const grew = await waitFor(() => getJobCards().length > before, { timeout: 4000 });
      if (grew) {
        await sleep(600); // 等新卡片渲染稳定
        return true;
      }
    }
    return false; // 滚了两次都没有新卡片，认为已全部加载
  }

  // 应用全部固定筛选（薪资/区域/行业/类型/经验/学历/公司规模/融资阶段）。
  // 每换一个关键词搜索后都会调用一次；已是目标值的项会快速跳过，开销很小。
  async function applyAllFilters(config) {
    if (config.salaryMin || config.salaryMax) {
      await applySalaryFilter(config.salaryMin, config.salaryMax);
      if (state.stopRequested) return;
    }
    await applyMultiSelectFilter(SEL.districtFilterTriggerTexts, config.districts, '区域');
    if (state.stopRequested) return;
    await applyMultiSelectFilter(SEL.industryFilterTriggerTexts, config.industries, '行业');
    if (state.stopRequested) return;
    await selectDropdownFilterByText(SEL.jobTypeFilterTriggerTexts, config.jobType, '求职类型');
    await selectDropdownFilterByText(SEL.experienceFilterTriggerTexts, config.experience, '工作经验');
    await selectDropdownFilterByText(SEL.degreeFilterTriggerTexts, config.degree, '学历要求');
    await selectDropdownFilterByText(SEL.companyScaleFilterTriggerTexts, config.companyScale, '公司规模');
    await selectDropdownFilterByText(SEL.financeStageFilterTriggerTexts, config.financeStage, '融资阶段');
  }

  // 处理"当前列表"：遍历已加载的卡片投递，滚动加载更多，直到列表到底
  // 或达到全局投递上限。processedThisRun 跨关键词共享，天然实现换词去重。
  async function processCurrentListing(seen, processedThisRun) {
    // 设置热更新：每个职位的匹配/话术/节奏都实时读取 state.config——
    // 在 popup 里修改排除词/薪资/区域/话术/上限/间隔后，storage 变更事件会
    // 更新 state.config，下一个职位立即按新规则执行，无需停止重启任务
    const maxApps = () => state.config.maxApplications || 20;
    let batch = 1;

    while (state.running && !state.stopRequested && state.appliedCount < maxApps()) {
      const cards = getJobCards();
      if (cards.length === 0) {
        const found = await waitFor(() => getJobCards().length > 0, { timeout: 5000 });
        if (!found) {
          log('当前页面未找到职位卡片', 'warn');
          return;
        }
      }

      const freshCards = getJobCards();
      const newOnes = freshCards.filter((c) => {
        try {
          const info = extractJobInfo(c);
          return info.jobId && !processedThisRun.has(info.jobId);
        } catch (_e) {
          return true; // 解析失败的卡片保留，交给主循环走异常计数
        }
      });
      log(`第 ${batch} 批：已加载 ${freshCards.length} 个职位，其中待处理 ${newOnes.length} 个`);
      let chattedCount = 0;
      let noTitleCount = 0;
      let seenCount = 0;

      for (const card of freshCards) {
        if (state.stopRequested || state.appliedCount >= maxApps()) break;

        await dismissGenericDialog();

        let info;
        try {
          info = extractJobInfo(card);
        } catch (e) {
          state.errorCount += 1;
          log(`解析职位卡片失败：${e.message}`, 'error');
          continue;
        }

        if (!info.title) {
          noTitleCount += 1;
          continue;
        }
        if (processedThisRun.has(info.jobId)) continue;
        if (seen.has(info.jobId)) {
          // 之前运行中已投递/已跳过/已沟通过的职位：静默跳过但计数，
          // 批末汇总打日志（避免整批无日志、看起来像卡住的困惑）
          seenCount += 1;
          processedThisRun.add(info.jobId);
          continue;
        }
        if (isCardAlreadyChatted(card)) {
          seen.add(info.jobId);
          await markSeen(info.jobId);
          processedThisRun.add(info.jobId);
          chattedCount += 1;
          continue;
        }

        // 从这里开始无论结果如何（跳过/成功/异常），本轮任务都不再重复处理该职位
        processedThisRun.add(info.jobId);

        // 实时取最新配置（popup 修改后立即生效）
        const cfg = state.config;
        const { matched, reason } = MATCH(info, cfg);
        if (!matched) {
          state.skippedCount += 1;
          seen.add(info.jobId);
          await markSeen(info.jobId);
          log(`跳过《${info.title}》@${info.company}：${reason}`);
          continue;
        }

        // 注意：只有"成功投递"或"确定要跳过"（不匹配 / 已打过招呼，见上方两处
        // seen.add）才会把 jobId 写入已处理列表。像"没找到按钮""发送失败""
        // 抛异常"这类偶发性技术故障不会标记为已处理，这样下次运行时会重试，
        // 而不是因为一次页面加载慢就把这个岗位永久拉黑。
        try {
          const opened = await openChatForCard(card);
          if (!opened) {
            state.errorCount += 1;
            log(`《${info.title}》@${info.company}：未找到打招呼按钮，跳过（下次会重试）`, 'warn');
            continue;
          }

          const result = await sendGreeting(cfg.greeting);
          if (result.ok) {
            state.appliedCount += 1;
            const note = result.appendedGreeting
              ? '（BOSS 已发默认招呼语，自定义话术已作为第二条消息补发）'
              : result.usedDefaultGreeting
                ? '（该职位使用了 BOSS 自带的默认招呼语，未能填入自定义话术，可在 BOSS「消息通知-设置招呼语」里修改默认文案）'
                : '';
            log(`已投递《${info.title}》@${info.company}（${info.salary}）${note}`, 'success');
            seen.add(info.jobId);
            await markSeen(info.jobId);
          } else {
            state.errorCount += 1;
            log(`《${info.title}》@${info.company}：${result.reason}（下次会重试）`, 'error');
          }
        } catch (e) {
          state.errorCount += 1;
          log(`处理《${info.title}》@${info.company} 时出错：${e.message}（下次会重试）`, 'error');
        }

        if (state.appliedCount >= maxApps()) break;

        const delay = randomDelay(cfg.minDelayMs, cfg.maxDelayMs);
        await sleep(delay);
      }

      if (state.stopRequested || state.appliedCount >= maxApps()) return;

      if (chattedCount > 0) {
        log(`本批另有 ${chattedCount} 个职位此前已沟通过，静默跳过`);
      }
      if (seenCount > 0) {
        log(`本批另有 ${seenCount} 个职位在此前运行中已处理过，静默跳过（换新关键词或清空记录可投新职位）`);
      }
      if (noTitleCount > 0) {
        log(`本批有 ${noTitleCount} 个职位未解析出职位名称（页面结构可能已改版，请更新 selectors.js 的 jobTitle 选择器）`, 'warn');
      }
      log('本批处理完毕，加载更多职位...');
      await dismissGenericDialog();
      const moved = await loadMoreJobs();
      if (!moved) {
        log('当前关键词下没有更多职位了');
        return;
      }
      batch += 1;
      await sleep(randomDelay(800, 1500));
    }
  }

  async function runAutomation(config) {
    if (!SEL || !MATCH) {
      log('脚本依赖未正确加载（selectors.js / matcher.js），请检查扩展是否完整安装', 'error');
      state.running = false;
      reportProgress();
      return;
    }

    state.running = true;
    state.stopRequested = false;
    state.config = config;
    state.appliedCount = 0;
    state.skippedCount = 0;
    state.errorCount = 0;
    state.log = [];

    log('开始自动投递任务');

    const seen = await loadSeenIds();
    // 本次任务内已处理过的职位（含异常）。跨关键词共享：同一个职位在不同
    // 关键词的搜索结果里重复出现时，靠它避免重复打开聊天框
    const processedThisRun = new Set();

    // 关键词轮换：依次用每个关键词搜索并投递，直到达到全局上限或全部搜完。
    // 留空关键词 = 不搜索，直接用当前页面已有的职位列表。
    // 注意：搜索队列在任务启动时确定，运行中修改关键词只影响匹配过滤，
    // 不会中途换搜（避免进度错乱），新队列下次任务生效。
    const keywordList = (config.keywords || []).filter(Boolean);
    if (keywordList.length > 0) {
      // 打印解析后的关键词列表：若分割异常（如整串未拆开），在这里一眼可见
      log(`共解析出 ${keywordList.length} 个关键词：${keywordList.join(' ｜ ')}`);
    }

    if (keywordList.length === 0) {
      await applyAllFilters(state.config);
      if (!state.stopRequested) {
        await processCurrentListing(seen, processedThisRun);
      }
    } else {
      for (let i = 0; i < keywordList.length; i++) {
        if (!state.running || state.stopRequested || state.appliedCount >= (state.config.maxApplications || 20)) break;

        log(`【关键词 ${i + 1}/${keywordList.length}】搜索「${keywordList[i]}」...`);
        await performSearch(keywordList[i]);
        if (state.stopRequested) break;

        // 每个关键词都用实时配置设置筛选：运行中改的区域/行业/薪资等，
        // 从下一个关键词开始即按新值应用
        await applyAllFilters(state.config);
        if (state.stopRequested) break;

        await processCurrentListing(seen, processedThisRun);
      }
    }

    state.running = false;
    log(`任务结束，共投递 ${state.appliedCount} 个职位，跳过 ${state.skippedCount} 个，${state.errorCount} 个异常`);
    reportProgress();
  }

  // 设置热更新：任务运行中在 popup 里修改设置，storage 变更事件实时推到这里
  // （事件驱动，无轮询）。更新 state.config 后，下一个职位立即按新规则匹配；
  // 区域/行业/薪资等原生筛选从下一个关键词起按新值应用。
  // 关键词搜索队列属任务级计划，仍以启动时为准，避免中途换队导致进度错乱。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.ba_config || !state.running) return;
    const next = changes.ba_config.newValue;
    if (!next) return;
    state.config = next;
    log('检测到设置变更，已实时应用（排除/筛选/话术/节奏）；关键词搜索队列下次任务生效');
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'BA_START') {
      if (state.running) {
        sendResponse({ ok: false, reason: '任务已在运行中' });
        return true;
      }
      runAutomation(message.config);
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'BA_STOP') {
      state.stopRequested = true;
      state.running = false;
      log('收到停止指令，正在结束当前任务...', 'warn');
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'BA_GET_STATE') {
      sendResponse({
        running: state.running,
        appliedCount: state.appliedCount,
        skippedCount: state.skippedCount,
        errorCount: state.errorCount,
        log: state.log.slice(-50)
      });
      return true;
    }
    return false;
  });
})();
