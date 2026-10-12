'use strict';

const fs = require('fs');
const path = require('path');
const { cleanName, normalizeUsername, usernameFromName } = require('../lib/auth');

const POLYPHONIC_SURNAMES = new Set([
  '柏', '查', '翟', '单', '盖', '纪', '解', '乐', '朴', '区', '仇', '任', '沈', '覃', '尉', '曾', '种', '重', '秘', '繁', '员',
]);

function usage() {
  console.error('用法：');
  console.error('  node scripts/audit-roster.js 名单.json --out 核对表.csv --json 核对表.json');
  console.error('  node scripts/audit-roster.js 核对表.json --seed data/runtime/account-seed.json');
  process.exit(1);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join('；') : String(value == null ? '' : value);
  return `"${text.replace(/"/g, '""')}"`;
}

function readInput(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Array.isArray(parsed)) return { names: parsed.map(item => typeof item === 'string' ? item : item.name) };
  if (Array.isArray(parsed.names)) return { names: parsed.names };
  if (Array.isArray(parsed.rows)) return { rows: parsed.rows };
  throw new Error('名单 JSON 需要是姓名数组、{names:[]} 或核对表 {rows:[]}');
}

function auditNames(names) {
  const rawRows = names.map((value, index) => {
    const rawName = String(value == null ? '' : value);
    const displayName = cleanName(rawName);
    return {
      row: index + 1,
      rawName,
      displayName,
      baseUsername: usernameFromName(displayName),
      username: '',
      reviewReasons: [],
      approved: false,
    };
  });

  const nameCounts = new Map();
  const baseCounts = new Map();
  for (const row of rawRows) {
    nameCounts.set(row.displayName, (nameCounts.get(row.displayName) || 0) + 1);
    baseCounts.set(row.baseUsername, (baseCounts.get(row.baseUsername) || 0) + 1);
  }

  const used = new Set();
  for (const row of rawRows) {
    const base = row.baseUsername;
    let username = base;
    let suffix = 2;
    while (username && used.has(username)) username = `${base}${suffix++}`;
    row.username = username;
    if (username) used.add(username);

    if (!row.displayName) row.reviewReasons.push('姓名为空');
    if (!row.baseUsername) row.reviewReasons.push('无法生成拼音账号');
    if (row.rawName !== row.displayName) row.reviewReasons.push('包含首尾或连续空格');
    if (/[A-Za-z]/.test(row.displayName)) row.reviewReasons.push('包含英文字符');
    if (/[^\p{Script=Han}A-Za-z0-9·.\-\s]/u.test(row.displayName)) row.reviewReasons.push('包含特殊字符');
    if (POLYPHONIC_SURNAMES.has(row.displayName[0])) row.reviewReasons.push('姓氏可能存在多音字');
    if ((nameCounts.get(row.displayName) || 0) > 1) row.reviewReasons.push('姓名重复');
    if ((baseCounts.get(row.baseUsername) || 0) > 1) row.reviewReasons.push('拼音账号冲突');
    row.needsReview = row.reviewReasons.length > 0;
  }
  return rawRows;
}

function writeAudit(rows, csvPath, jsonPath) {
  if (csvPath) {
    const header = ['来源行号', '原姓名', '规范姓名', '建议账号', '需要核对', '核对原因'];
    const lines = [header, ...rows.map(row => [
      row.row, row.rawName, row.displayName, row.username,
      row.needsReview ? '是' : '否', row.reviewReasons,
    ])];
    fs.writeFileSync(csvPath, lines.map(line => line.map(csvCell).join(',')).join('\n') + '\n', 'utf8');
  }
  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify({
      _note: 'needsReview=true 的行必须人工确认；如需修改账号，直接编辑 username，并把 approved 改为 true。',
      generatedAt: new Date().toISOString(),
      count: rows.length,
      rows,
    }, null, 2) + '\n', 'utf8');
  }
}

function writeSeed(rows, outputPath) {
  const unresolved = rows.filter(row => row.needsReview && row.approved !== true);
  if (unresolved.length) {
    throw new Error(`还有 ${unresolved.length} 条异常姓名未确认，不能生成正式账号种子`);
  }
  const usernames = new Set();
  for (const row of rows) {
    row.displayName = cleanName(row.displayName);
    row.username = normalizeUsername(row.username);
    if (!row.displayName || !row.username) throw new Error(`第 ${row.row} 行姓名或账号为空`);
    if (usernames.has(row.username)) throw new Error(`账号重复：${row.username}`);
    usernames.add(row.username);
  }
  const seed = {
    _note: '经人工核对。初始密码等于 username，运行时只保存 scrypt 哈希。',
    accounts: rows.map(row => ({ displayName: row.displayName, username: row.username })),
  };
  fs.writeFileSync(outputPath, JSON.stringify(seed, null, 2) + '\n', 'utf8');
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath || inputPath.startsWith('--')) usage();
  const input = readInput(inputPath);
  const seedPath = arg('--seed');
  if (seedPath) {
    if (!input.rows) throw new Error('--seed 必须使用核对表 JSON 作为输入');
    writeSeed(input.rows, path.resolve(seedPath));
    console.log(`已生成正式账号种子：${seedPath}（${input.rows.length} 人）`);
    return;
  }
  const rows = auditNames(input.names || []);
  const csvPath = arg('--out') || 'roster-audit.csv';
  const jsonPath = arg('--json') || 'roster-audit.json';
  writeAudit(rows, path.resolve(csvPath), path.resolve(jsonPath));
  const flagged = rows.filter(row => row.needsReview).length;
  console.log(`名单 ${rows.length} 人，需人工核对 ${flagged} 人`);
  console.log(`CSV：${csvPath}`);
  console.log(`JSON：${jsonPath}`);
}

try { main(); }
catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
