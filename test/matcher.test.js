const test = require('node:test');
const assert = require('node:assert/strict');
const { matchJob, parseSalaryRange } = require('../src/shared/matcher.js');

test('matches on keyword hit in title', () => {
  const job = { title: '高级前端工程师', company: 'A公司', salary: '20-30K', tagsText: 'React TypeScript' };
  const { matched } = matchJob(job, { keywords: ['前端'] });
  assert.equal(matched, true);
});

test('rejects when no keyword matches', () => {
  const job = { title: '销售经理', company: 'A公司', salary: '10-15K', tagsText: '' };
  const { matched } = matchJob(job, { keywords: ['前端', 'Java'] });
  assert.equal(matched, false);
});

test('rejects on exclude keyword', () => {
  const job = { title: '前端工程师（外包）', company: 'A公司', salary: '15-20K', tagsText: '' };
  const { matched, reason } = matchJob(job, { keywords: ['前端'], excludeKeywords: ['外包'] });
  assert.equal(matched, false);
  assert.match(reason, /排除关键词/);
});

test('rejects on excluded company', () => {
  const job = { title: '前端工程师', company: '黑名单公司', salary: '15-20K', tagsText: '' };
  const { matched } = matchJob(job, { keywords: ['前端'], excludeCompanies: ['黑名单公司'] });
  assert.equal(matched, false);
});

test('filters by salary overlap', () => {
  const job = { title: '前端工程师', company: 'A公司', salary: '10-14K', tagsText: '' };
  const { matched } = matchJob(job, { keywords: ['前端'], salaryMin: 15, salaryMax: 25 });
  assert.equal(matched, false);
});

test('accepts overlapping salary range', () => {
  const job = { title: '前端工程师', company: 'A公司', salary: '13-18K', tagsText: '' };
  const { matched } = matchJob(job, { keywords: ['前端'], salaryMin: 15, salaryMax: 25 });
  assert.equal(matched, true);
});

test('empty keyword list means no restriction', () => {
  const job = { title: '随便什么岗位', company: 'A公司', salary: '5-8K', tagsText: '' };
  const { matched } = matchJob(job, { keywords: [] });
  assert.equal(matched, true);
});

test('parseSalaryRange handles common formats', () => {
  assert.deepEqual(parseSalaryRange('15-25K'), { min: 15, max: 25 });
  assert.deepEqual(parseSalaryRange('15-25K·14薪'), { min: 15, max: 25 });
  assert.deepEqual(parseSalaryRange('20K以上'), { min: 20, max: Infinity });
  assert.equal(parseSalaryRange(''), null);
});

test('accepts job in desired district (short name matches)', () => {
  const job = { title: '前端工程师', company: 'A公司', salary: '15-25K', area: '北京·海淀区·中关村', tagsText: '' };
  const { matched } = matchJob(job, { districts: ['海淀', '朝阳区'] });
  assert.equal(matched, true);
});

test('rejects job outside desired districts', () => {
  const job = { title: '前端工程师', company: 'A公司', salary: '15-25K', area: '北京·通州区·马驹桥', tagsText: '' };
  const { matched, reason } = matchJob(job, { districts: ['海淀区', '朝阳区'] });
  assert.equal(matched, false);
  assert.match(reason, /区域不符/);
});

test('job without parsed area is not blocked by district filter', () => {
  const job = { title: '前端工程师', company: 'A公司', salary: '15-25K', area: '', tagsText: '' };
  const { matched } = matchJob(job, { districts: ['海淀区'] });
  assert.equal(matched, true);
});

test('all-mode requires every keyword (precise matching)', () => {
  const job = { title: 'B端产品经理', company: 'A公司', salary: '15-25K', tagsText: '', jobDesc: '' };
  // 含"产品"不含"硬件" → 精准模式应拒绝
  const miss = matchJob(job, { keywords: ['产品', '硬件'], matchMode: 'all' });
  assert.equal(miss.matched, false);
  assert.match(miss.reason, /未同时包含全部关键词/);
  // 两个都含 → 通过
  const hit = matchJob(job, { keywords: ['产品', 'B端'], matchMode: 'all' });
  assert.equal(hit.matched, true);
});

test('all-mode can require keywords across title and jobDesc', () => {
  // "硬件"只出现在职位描述里，精准模式同样命中
  const job = { title: '产品经理', company: 'A公司', salary: '15-25K', tagsText: '', jobDesc: '负责智能硬件产品的规划与落地' };
  const { matched } = matchJob(job, { keywords: ['产品', '硬件'], matchMode: 'all' });
  assert.equal(matched, true);
});

test('jobDesc participates in exclude-keyword matching', () => {
  // 标题干净但描述里是"食品电商"→ 命中排除词"食品"应跳过
  const job = { title: '产品经理', company: 'A公司', salary: '15-25K', tagsText: '', jobDesc: '负责食品电商平台产品线' };
  const { matched, reason } = matchJob(job, { keywords: ['产品'], excludeKeywords: ['食品'] });
  assert.equal(matched, false);
  assert.match(reason, /排除关键词/);
});

test('any-mode (default) still matches on any single keyword', () => {
  const job = { title: '产品经理', company: 'A公司', salary: '15-25K', tagsText: '', jobDesc: '' };
  const { matched } = matchJob(job, { keywords: ['产品', '硬件'] });
  assert.equal(matched, true);
});
