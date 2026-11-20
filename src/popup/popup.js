// popup.js
// 负责：读写用户配置（chrome.storage.local）、控制 content script 的启停、
// 展示实时进度日志。

const JOB_PAGE_PREFIX = 'https://www.zhipin.com/web/geek/job';
const STORAGE_KEY_CONFIG = 'ba_config';

const els = {
  hint: document.getElementById('not-on-page-hint'),
  form: document.getElementById('config-form'),
  keywords: document.getElementById('keywords'),
  matchMode: document.getElementById('matchMode'),
  excludeKeywords: document.getElementById('excludeKeywords'),
  excludeCompanies: document.getElementById('excludeCompanies'),
  salaryMin: document.getElementById('salaryMin'),
  salaryMax: document.getElementById('salaryMax'),
  districts: document.getElementById('districts'),
  industries: document.getElementById('industries'),
  companyScale: document.getElementById('companyScale'),
  financeStage: document.getElementById('financeStage'),
  jobType: document.getElementById('jobType'),
  experience: document.getElementById('experience'),
  degree: document.getElementById('degree'),
  greeting: document.getElementById('greeting'),
  maxApplications: document.getElementById('maxApplications'),
  minDelay: document.getElementById('minDelay'),
  maxDelay: document.getElementById('maxDelay'),
  startBtn: document.getElementById('start-btn'),
  stopBtn: document.getElementById('stop-btn'),
  statusBadge: document.getElementById('status-badge'),
  appliedCount: document.getElementById('applied-count'),
  skippedCount: document.getElementById('skipped-count'),
  errorCount: document.getElementById('error-count'),
  logPanel: document.getElementById('log-panel')
};

const DEFAULT_GREETING = '您好，我对这个岗位很感兴趣，我的经历和岗位要求比较契合，期待能和您聊聊，谢谢！';

function splitList(value) {
  // 支持混用的分隔符：半角/全角逗号、顿号、半角/全角分号
  // （中文输入法下逗号 , 和顿号 、 极易混按，之前只认逗号会导致整串无法分割）
  return (value || '')
    .split(/[,，、;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function readConfigFromForm() {
  return {
    keywords: splitList(els.keywords.value),
    matchMode: els.matchMode.value === 'all' ? 'all' : 'any',
    excludeKeywords: splitList(els.excludeKeywords.value),
    excludeCompanies: splitList(els.excludeCompanies.value),
    salaryMin: Number(els.salaryMin.value) || 0,
    salaryMax: Number(els.salaryMax.value) || 0,
    districts: splitList(els.districts.value),
    industries: splitList(els.industries.value),
    companyScale: els.companyScale.value.trim(),
    financeStage: els.financeStage.value.trim(),
    jobType: els.jobType.value,
    experience: els.experience.value,
    degree: els.degree.value,
    greeting: els.greeting.value.trim() || DEFAULT_GREETING,
    maxApplications: Math.min(200, Math.max(1, Number(els.maxApplications.value) || 20)),
    minDelayMs: Math.max(1000, (Number(els.minDelay.value) || 3) * 1000),
    maxDelayMs: Math.max(1000, (Number(els.maxDelay.value) || 8) * 1000)
  };
}

function writeConfigToForm(config) {
  if (!config) return;
  els.keywords.value = (config.keywords || []).join(', ');
  els.matchMode.value = config.matchMode === 'all' ? 'all' : 'any';
  els.excludeKeywords.value = (config.excludeKeywords || []).join(', ');
  els.excludeCompanies.value = (config.excludeCompanies || []).join(', ');
  els.salaryMin.value = config.salaryMin || '';
  els.salaryMax.value = config.salaryMax || '';
  els.districts.value = (config.districts || []).join(', ');
  els.industries.value = (config.industries || []).join(', ');
  els.companyScale.value = config.companyScale || '';
  els.financeStage.value = config.financeStage || '';
  els.jobType.value = config.jobType || '';
  els.experience.value = config.experience || '';
  els.degree.value = config.degree || '';
  els.greeting.value = config.greeting || DEFAULT_GREETING;
  els.maxApplications.value = config.maxApplications || 20;
  els.minDelay.value = (config.minDelayMs || 3000) / 1000;
  els.maxDelay.value = (config.maxDelayMs || 8000) / 1000;
}

async function loadSavedConfig() {
  const data = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
  writeConfigToForm(data[STORAGE_KEY_CONFIG] || { greeting: DEFAULT_GREETING });
}

async function saveConfig(config) {
  await chrome.storage.local.set({ [STORAGE_KEY_CONFIG]: config });
}

async function getActiveJobTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.startsWith(JOB_PAGE_PREFIX)) return tab;
  return null;
}

function renderState(state) {
  if (!state) return;
  els.appliedCount.textContent = state.appliedCount || 0;
  els.skippedCount.textContent = state.skippedCount || 0;
  els.errorCount.textContent = state.errorCount || 0;

  els.startBtn.disabled = !!state.running;
  els.stopBtn.disabled = !state.running;

  els.statusBadge.textContent = state.running ? '运行中' : '未运行';
  els.statusBadge.className = 'badge ' + (state.running ? 'running' : 'idle');

  els.logPanel.innerHTML = '';
  (state.log || []).forEach((entry) => {
    const line = document.createElement('div');
    line.className = `log-line ${entry.level || 'info'}`;
    line.textContent = `[${entry.time}] ${entry.message}`;
    els.logPanel.appendChild(line);
  });
  els.logPanel.scrollTop = els.logPanel.scrollHeight;
}

async function refreshStateFromBackground() {
  const state = await chrome.runtime.sendMessage({ type: 'BA_GET_LATEST_STATE' }).catch(() => null);
  renderState(state);
}

async function init() {
  await loadSavedConfig();

  const tab = await getActiveJobTab();
  els.hint.classList.toggle('hidden', !!tab);
  els.startBtn.disabled = !tab;

  await refreshStateFromBackground();

  if (tab) {
    const liveState = await chrome.tabs.sendMessage(tab.id, { type: 'BA_GET_STATE' }).catch(() => null);
    if (liveState) renderState(liveState);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'BA_PROGRESS') {
      renderState(message.payload);
    }
  });

  els.startBtn.addEventListener('click', async () => {
    const activeTab = await getActiveJobTab();
    if (!activeTab) {
      els.hint.classList.remove('hidden');
      return;
    }
    const config = readConfigFromForm();
    await saveConfig(config);

    const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'BA_START', config }).catch((e) => ({
      ok: false,
      reason: e.message
    }));

    if (!response || !response.ok) {
      const reason = response ? response.reason : '无法连接到页面';
      // "Receiving end does not exist" = 页面里没有插件脚本。
      // 最常见原因：刷新扩展后没有刷新 Boss 页面（扩展重载后旧标签页不会自动重新注入）
      const hint = /Receiving end does not exist/i.test(reason)
        ? '页面尚未加载插件脚本。\n请到 Boss 职位页面按 Cmd+R 刷新后重试。\n（每次刷新扩展后，Boss 页面也必须刷新一次）'
        : '请刷新 Boss 职位页面后重试';
      alert('启动失败：' + reason + '\n\n' + hint);
      return;
    }
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.statusBadge.textContent = '运行中';
    els.statusBadge.className = 'badge running';
  });

  els.stopBtn.addEventListener('click', async () => {
    const activeTab = await getActiveJobTab();
    if (!activeTab) return;
    await chrome.tabs.sendMessage(activeTab.id, { type: 'BA_STOP' }).catch(() => {});
    els.stopBtn.disabled = true;
  });

  // 清空已处理记录：测试或换批次时用，清空后之前跳过/投递过的职位会被重新处理
  // （注意：任务运行中不清，避免与 content script 的内存状态冲突）
  document.getElementById('clear-seen-btn').addEventListener('click', async () => {
    const state = await chrome.runtime.sendMessage({ type: 'BA_GET_LATEST_STATE' }).catch(() => null);
    if (state && state.running) {
      alert('任务正在运行中，请先停止再清空记录。');
      return;
    }
    if (!confirm('确定清空已投递/已跳过的职位记录？\n\n清空后，之前处理过的职位会在下次任务中被重新匹配和投递（已沟通过的职位仍会被自动跳过）。')) {
      return;
    }
    await chrome.storage.local.remove('ba_seen_job_ids');
    const btn = document.getElementById('clear-seen-btn');
    btn.textContent = '✅ 已清空';
    setTimeout(() => (btn.textContent = '🗑 清空记录'), 2000);
  });

  // 一键页面诊断：检测 Boss 页面结构与插件选择器的匹配情况，
  // 结果自动复制到剪贴板（用于页面改版后更新 selectors.js）
  els.diagnoseBtn = document.getElementById('diagnose-btn');
  els.diagnoseResult = document.getElementById('diagnose-result');
  els.diagnoseBtn.addEventListener('click', async () => {
    els.diagnoseResult.classList.remove('hidden');
    els.diagnoseResult.textContent = '⏳ 正在检测页面结构...';
    let tab = await getActiveJobTab();
    if (!tab) {
      const tabs = await chrome.tabs.query({ url: 'https://www.zhipin.com/*' });
      // 优先选职位搜索结果页（/web/geek/job...），避免误检测首页等其他页面
      tab = tabs.find((t) => /\/web\/geek\/(job|jobs)/.test(t.url || '')) || tabs[0];
    }
    if (!tab || !/\/web\/geek\/(job|jobs)/.test(tab.url || '')) {
      els.diagnoseResult.textContent =
        '❌ 请先在 Boss 上搜索一个岗位（如"产品经理"），打开带职位列表卡片的搜索结果页，再点诊断。\n' +
        '（当前找到的页面不是职位搜索结果页：' + (tab ? tab.url : '未找到任何 Boss 标签页') + '）';
      return;
    }
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const out = { url: location.href, cards: {}, fields: {}, html: '' };
          ['.job-card-wrapper', '.job-card-box', '.job-primary'].forEach((s) => {
            out.cards[s] = document.querySelectorAll(s).length;
          });
          const card =
            document.querySelector('.job-card-wrapper') ||
            document.querySelector('.job-card-box') ||
            document.querySelector('.job-primary');
          if (!card) {
            out.html = 'NO_CARD_FOUND: 三种卡片选择器都没命中，页面可能已改版';
            return JSON.stringify(out, null, 2);
          }
          [
            ['title', ['.job-name', '.job-title']],
            ['company', ['.company-name', '.company-text .name']],
            ['salary', ['.salary']],
            ['area', ['.job-area', '.company-location']],
            ['desc', ['.info-desc', '.job-desc']]
          ].forEach(([k, sels]) => {
            out.fields[k] = {};
            sels.forEach((s) => {
              out.fields[k][s] = card.querySelector(s)?.textContent?.trim()?.slice(0, 30) ?? null;
            });
          });
          out.html = card.outerHTML.slice(0, 2000);
          return JSON.stringify(out, null, 2);
        }
      });
      const text = res.result || '（无返回结果）';
      els.diagnoseResult.textContent = text;
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (_e) {
        /* 剪贴板不可用时降级为手动复制 */
      }
      els.diagnoseBtn.textContent = copied
        ? '✅ 已复制，去粘贴给助手'
        : '📋 请手动选中方框内文字复制';
      setTimeout(() => (els.diagnoseBtn.textContent = '📋 一键诊断'), 4000);
    } catch (e) {
      els.diagnoseResult.textContent = '❌ 诊断失败：' + e.message + '\n请确认已刷新 Boss 页面后重试';
    }
  });

  els.form.addEventListener('change', async () => {
    await saveConfig(readConfigFromForm());
  });
}

init();
