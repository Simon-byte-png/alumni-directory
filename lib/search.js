'use strict';
/*
 * 校友检索引擎（纯 Node，无外部依赖）
 * 方案：中文二元分词 + 字段加权 + IDF + 方向同义词扩展。
 * 关键点：
 *   1. 索引与匹配【绝不】包含联系方式字段（contact），从源头杜绝检索泄露。
 *   2. 姓名默认不参与语义评分（避免"搜个词碰巧撞到人名"），但支持精确姓名查找。
 */

// 不预置行业用词。需要同义词时，由部署方在这里按组添加。
const SYNONYMS = [];

// 构建 词 -> 同组所有词 的映射
const SYN_MAP = new Map();
for (const group of SYNONYMS) {
  for (const w of group) {
    const set = SYN_MAP.get(w) || new Set();
    for (const x of group) set.add(x);
    SYN_MAP.set(w, set);
  }
}

// 参与语义检索的字段及权重 —— 由 config.publicFields 决定，非公开字段（org/offer/status/contact）永不索引
const CONFIG = require('../config');
const FIELD_LABELS = CONFIG.fieldLabels;
const FIELD_WEIGHTS = {};
for (const f of CONFIG.publicFields) {
  // 姓名单独走精确匹配，不进语义索引；其余公开字段按配置权重索引
  if (f === 'name') continue;
  FIELD_WEIGHTS[f] = CONFIG.fieldWeights[f] != null ? CONFIG.fieldWeights[f] : 1.0;
}

const STOP = new Set(['的', '了', '和', '与', '在', '是', '我', '有', '想', '找', '一个', '方向', '校友', '相关', '做', '的人']);

// 归一化：小写、全角转半角、去多余空白
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[，。、；：！？·（）【】「」《》/\\\-_,.;:!?()\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 分词：连续英文/数字整体成词；中文按单字 + 相邻二元组
function tokenize(s) {
  const text = norm(s);
  const tokens = [];
  const re = /[a-z0-9]+|[一-龥]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const seg = m[0];
    if (/^[a-z0-9]+$/.test(seg)) {
      if (!STOP.has(seg)) tokens.push(seg);
    } else {
      const chars = [...seg];
      if (chars.length === 1) {
        // 单字查询才用单字（如按姓氏/单字方向），否则单字噪声太大
        if (!STOP.has(chars[0])) tokens.push(chars[0]);
      } else {
        // 多字：只取相邻二元组，"医疗""投资"整体匹配，避免单字过度召回
        for (let i = 0; i < chars.length - 1; i++) {
          const bg = chars[i] + chars[i + 1];
          if (!STOP.has(bg)) tokens.push(bg);
        }
      }
    }
  }
  return tokens;
}

// 查询词做同义词扩展（带权，扩展词权重稍低）
function expandQuery(q) {
  const base = tokenize(q);
  const weighted = new Map(); // token -> weight
  for (const t of base) weighted.set(t, Math.max(weighted.get(t) || 0, 1));
  for (const t of base) {
    const syns = SYN_MAP.get(t);
    if (syns) {
      for (const s of syns) {
        if (s === t) continue;
        for (const st of tokenize(s)) {
          weighted.set(st, Math.max(weighted.get(st) || 0, 0.7));
        }
      }
    }
  }
  return weighted;
}

/*
 * 姓名匹配（类似微信通讯录搜索）：
 *  - 汉字查询："王" -> 所有姓王的人（前缀/包含匹配）；"王宁" -> 精确更高分
 *  - 拼音全拼："wang" -> 姓王的；"wangning" -> 王宁
 *  - 首字母简拼："wn" -> 王宁；"w" -> 姓王的
 * 返回加到该记录总分上的姓名匹配分（0 表示不匹配）。
 */
function matchName(rec, needle) {
  const q = (needle || '').replace(/\s+/g, '');
  if (!q) return 0;
  const name = norm(rec.name).replace(/\s+/g, '');
  if (!name) return 0;

  // 含汉字：按姓名文字匹配
  if (/[一-龥]/.test(q)) {
    if (name === q) return 14;
    if (name.startsWith(q)) return 11;   // 单姓氏或姓名前缀 -> 命中同姓所有人
    if (name.includes(q)) return 7;
    return 0;
  }

  // 纯字母：按拼音全拼 / 首字母简拼匹配
  if (/^[a-z]+$/.test(q)) {
    const py = rec.namePinyin || '';
    const ini = rec.nameInitials || '';
    if (py && py === q) return 13;
    if (ini && ini === q) return 12;      // 完整首字母，如 "wn"
    if (py && py.startsWith(q)) return 10; // 全拼前缀，如 "wang" / "wangn"
    if (ini && ini.startsWith(q)) return 9; // 首字母前缀，如单姓 "w"
    if (py && py.includes(q)) return 4;
    return 0;
  }
  return 0;
}

class SearchIndex {
  constructor(records) {
    this.records = records;
    this.N = records.length;
    this.df = new Map();          // token -> 文档频次
    this.docTokens = [];          // [{ token -> {field->tf} }]
    this._build();
  }

  _build() {
    for (const rec of this.records) {
      const perToken = new Map();
      const seen = new Set();
      for (const field of Object.keys(FIELD_WEIGHTS)) {
        const toks = tokenize(rec[field]);
        for (const t of toks) {
          if (!perToken.has(t)) perToken.set(t, {});
          perToken.get(t)[field] = (perToken.get(t)[field] || 0) + 1;
          seen.add(t);
        }
      }
      this.docTokens.push(perToken);
      for (const t of seen) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
  }

  idf(t) {
    const df = this.df.get(t) || 0;
    return Math.log((this.N + 1) / (df + 1)) + 1;
  }

  search(query, { limit = 30 } = {}) {
    const q = (query || '').trim();
    if (!q) return [];
    const qWeighted = expandQuery(q);
    const nameNeedle = norm(q);

    const results = [];
    for (let i = 0; i < this.records.length; i++) {
      const rec = this.records[i];
      const perToken = this.docTokens[i];
      let score = 0;
      const hitFields = new Map(); // field -> score contrib

      for (const [t, qw] of qWeighted) {
        const fieldTf = perToken.get(t);
        if (!fieldTf) continue;
        const idf = this.idf(t);
        for (const [field, tf] of Object.entries(fieldTf)) {
          const contrib = qw * idf * FIELD_WEIGHTS[field] * (1 + Math.log(tf));
          score += contrib;
          hitFields.set(field, (hitFields.get(field) || 0) + contrib);
        }
      }

      // 姓名匹配：支持 汉字（含单姓氏前缀）/ 拼音全拼 / 首字母简拼
      const nameScore = matchName(rec, nameNeedle);
      if (nameScore > 0) {
        score += nameScore;
        hitFields.set('name', (hitFields.get('name') || 0) + nameScore);
      }

      if (score > 0) {
        const reasons = [...hitFields.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([f]) => f === 'name' ? '姓名' : FIELD_LABELS[f])
          .filter(Boolean);
        results.push({ index: i, score, reasons });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const max = results.length ? results[0].score : 1;
    return results.slice(0, limit).map(r => ({
      ...r,
      relevance: Math.round((r.score / max) * 100),
    }));
  }
}

module.exports = { SearchIndex, tokenize, FIELD_LABELS };
