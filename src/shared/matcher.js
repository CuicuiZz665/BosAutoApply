// 职位匹配逻辑：根据用户配置判断一个职位是否符合投递条件。
// 纯函数，不依赖 DOM，方便独立测试。

/**
 * @param {{
 *   title: string,
 *   company: string,
 *   salary: string,
 *   area: string,
 *   jobDesc: string,            // 职位卡片上的一句话描述（参与关键词/排除词匹配）
 *   tagsText: string
 * }} job
 * @param {{
 *   keywords: string[],          // 关键词，按 matchMode 决定匹配方式（为空表示不限制）
 *   matchMode: string,           // 'any' 命中任意一个即匹配（默认，广撒网）；'all' 必须全部包含（精准）
 *   excludeKeywords: string[],   // 排除关键词，标题/描述/标签/公司命中任意一个即跳过
 *   excludeCompanies: string[],  // 公司黑名单（子串匹配）
 *   salaryMin: number,           // 单位：K，0 表示不限制
 *   salaryMax: number,           // 单位：K，0 表示不限制
 *   districts: string[]          // 期望区域（区/县，子串匹配，如"海淀"可命中"海淀区"；为空表示不限制）
 * }} config
 * @returns {{matched: boolean, reason: string}}
 */
function matchJob(job, config) {
  const title = (job.title || '').trim();
  const company = (job.company || '').trim();
  const tagsText = (job.tagsText || '').trim();
  const jobDesc = (job.jobDesc || '').trim();
  const haystack = `${title} ${tagsText} ${jobDesc}`.toLowerCase();
  const companyLower = company.toLowerCase();

  if (!title) {
    return { matched: false, reason: '未能解析出职位名称，跳过' };
  }

  const excludeKeywords = (config.excludeKeywords || []).map((s) => s.toLowerCase()).filter(Boolean);
  for (const kw of excludeKeywords) {
    if (haystack.includes(kw) || companyLower.includes(kw)) {
      return { matched: false, reason: `命中排除关键词「${kw}」` };
    }
  }

  const excludeCompanies = (config.excludeCompanies || []).map((s) => s.toLowerCase()).filter(Boolean);
  for (const c of excludeCompanies) {
    if (companyLower.includes(c)) {
      return { matched: false, reason: `公司命中黑名单「${c}」` };
    }
  }

  const keywords = (config.keywords || []).map((s) => s.toLowerCase()).filter(Boolean);
  if (keywords.length > 0) {
    // matchMode：'all' = 必须全部包含（精准模式）；'any'/默认 = 命中任意一个（广撒网）
    const isAllMode = config.matchMode === 'all';
    const hit = isAllMode
      ? keywords.every((kw) => haystack.includes(kw))
      : keywords.some((kw) => haystack.includes(kw));
    if (!hit) {
      return { matched: false, reason: isAllMode ? '未同时包含全部关键词' : '未命中任何关键词' };
    }
  }

  const salaryRange = parseSalaryRange(job.salary);
  if (salaryRange && (config.salaryMin || config.salaryMax)) {
    const min = config.salaryMin || 0;
    const max = config.salaryMax || Infinity;
    // 只要职位薪资区间与用户期望区间有交集就算匹配
    const overlap = salaryRange.max >= min && salaryRange.min <= max;
    if (!overlap) {
      return { matched: false, reason: `薪资 ${job.salary} 不在期望范围内` };
    }
  }

  // 区域二次过滤：卡片区域文字（如"北京·海淀·中关村"）不含任一期望区域则跳过。
  // 输入"海淀"能命中"海淀区"（子串匹配）。卡片没解析出区域文字时不拦截——
  // 原生"区域"筛选已在源头把大方向筛过，这里只做兜底。
  const districts = (config.districts || []).filter(Boolean);
  if (districts.length > 0) {
    const area = (job.area || '').trim();
    if (area && !districts.some((d) => area.includes(d))) {
      return { matched: false, reason: `区域不符（职位在 ${area}）` };
    }
  }

  return { matched: true, reason: '匹配成功' };
}

/**
 * 解析类似 "15-25K"、"15-25K·14薪"、"20K以上" 的薪资字符串为 {min, max}（单位 K）。
 * 解析失败时返回 null（此时不参与薪资过滤）。
 */
function parseSalaryRange(salaryStr) {
  if (!salaryStr) return null;
  const s = String(salaryStr).replace(/\s/g, '');
  const rangeMatch = s.match(/(\d+(?:\.\d+)?)K?-(\d+(?:\.\d+)?)K/i);
  if (rangeMatch) {
    return { min: parseFloat(rangeMatch[1]), max: parseFloat(rangeMatch[2]) };
  }
  const aboveMatch = s.match(/(\d+(?:\.\d+)?)K以上/i);
  if (aboveMatch) {
    return { min: parseFloat(aboveMatch[1]), max: Infinity };
  }
  const singleMatch = s.match(/(\d+(?:\.\d+)?)K/i);
  if (singleMatch) {
    const v = parseFloat(singleMatch[1]);
    return { min: v, max: v };
  }
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { matchJob, parseSalaryRange };
}
