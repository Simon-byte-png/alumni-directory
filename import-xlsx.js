'use strict';
/*
 * 从校友信息表 .xlsx 导入数据 -> data/runtime/alumni-import.json
 * 用法: node import-xlsx.js "<xlsx文件路径>" [输出JSON路径]
 * 按列位置精确映射（表结构固定），并做两项归一化：
 *   - cohortYear：从五花八门的届别文字里抽出入学年份，供筛选下拉使用
 *   - cityNorm ：城市轻度归一（去「市」、多城市取第一个），供筛选下拉使用
 * 原始文字仍保留在 cohort / city 里用于展示。
 */
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { pinyin } = require('pinyin-pro'); // 仅导入时使用，结果预计算写入 JSON，线上运行零依赖

// 预计算姓名拼音：全拼(wangning) 与 首字母(wn)，均小写无声调
function namePinyinPair(name) {
  const py = pinyin(name, { toneType: 'none', type: 'array', nonZh: 'consecutive' }) || [];
  const full = py.join('').toLowerCase().replace(/[^a-z]/g, '');
  const initials = py.map(s => (s[0] || '')).join('').toLowerCase().replace(/[^a-z]/g, '');
  return { full, initials };
}

const file = process.argv[2];
if (!file) {
  console.error('用法: node import-xlsx.js "<xlsx文件路径>" [输出JSON路径]');
  process.exit(1);
}

// 列索引（0基）
const COL = {
  name: 1, edu: 2, cohort: 3, status: 4, industry: 5, org: 6, doing: 7,
  city: 8, offer: 9, want: 10, hiring: 11, message: 12, willingContact: 13, contact: 14,
};

const clean = v => String(v == null ? '' : v).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();

function cohortYear(s) {
  s = String(s || '');
  const four = s.match(/(?:19|20)\d{2}/g);
  if (four) return String(Math.min(...four.map(Number)));
  const jie = s.match(/(\d{2})\s*届/);
  if (jie) return String(2000 + parseInt(jie[1], 10));
  const bare = s.match(/^\s*(\d{2})\s*$/);
  if (bare) return String(2000 + parseInt(bare[1], 10));
  return '未知';
}

// 城市规范化：多城市取首个、按城市级别归并、中英文/别名统一到一个规范城市名
const CITY_RULES = [
  ['杭州', ['杭州', 'hangzhou', '滨江']],
  ['北京', ['北京', '海淀', '朝阳', '中关村']],
  ['上海', ['上海']],
  ['深圳', ['深圳', '南山']],
  ['广州', ['广州']],
  ['宁波', ['宁波']],
  ['无锡', ['无锡']],
  ['武汉', ['武汉']],
  ['成都', ['成都']],
  ['南通', ['南通']],
  ['香港', ['香港', '红磡', '九龙']],
  ['新加坡', ['新加坡', 'singapore']],
  ['纽约', ['纽约', 'new york']],
  ['纽黑文', ['纽黑文', 'new haven']],
  ['旧金山湾区', ['湾区', '硅谷', '旧金山', 'bay area', 'san francisco', 'sf']],
  ['西雅图', ['西雅图', 'seattle']],
  ['芝加哥', ['芝加哥', 'chicago']],
  ['亚特兰大', ['亚特兰大', 'atlanta']],
  ['休斯顿', ['休斯顿', 'houston']],
  ['柏林', ['柏林', 'berlin']],
  ['都柏林', ['都柏林', 'dublin']],
];

function cityCanon(raw) {
  const s = clean(raw);
  if (!s) return '';
  // 拆成候选片段（多城市、各种分隔符）
  const segs = s.split(/[\/、，,和&与;；()（）\s]+/).map(x => x.trim()).filter(Boolean);
  // 优先：任一片段命中已知规范城市（按顺序取第一个命中的）
  for (const seg of segs) {
    const low = seg.toLowerCase();
    for (const [canon, keys] of CITY_RULES) {
      if (keys.some(k => low.includes(k))) return canon;
    }
  }
  // 兜底：取第一个片段，去国家/省前缀与市区县后缀
  let f = (segs[0] || '');
  f = f.replace(/^(中国|美国|英国|德国|法国|日本|加拿大|爱尔兰)/, '')
       .replace(/^(浙江|广东|江苏|湖北|四川|山东|河南|福建)省?/, '')
       .replace(/(省|市|区|县|州)$/g, '');
  f = f.trim();
  // 明显非城市/乱填的值归入「其他」
  if (!f || /^(背景|无|暂无|保密|不方便|待定|未定|其它|na|n\/a)$/i.test(f)) return '其他';
  return f;
}

function main() {
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!clean(row[COL.name])) continue;
    const rec = {};
    for (const [f, c] of Object.entries(COL)) rec[f] = clean(row[c]);
    rec.cohortYear = cohortYear(rec.cohort);
    rec.cityNorm = cityCanon(rec.city);
    const pp = namePinyinPair(rec.name);
    rec.namePinyin = pp.full;       // 王宁 -> wangning
    rec.nameInitials = pp.initials; // 王宁 -> wn
    rec.id = 'a' + String(records.length + 1).padStart(4, '0');
    records.push(rec);
  }

  const out = {
    _note: `校友数据（本地导入）。共 ${records.length} 条。联系方式等隐私字段仅存服务端，检索接口永不返回。`,
    records,
  };
  const dest = path.resolve(
    process.argv[3] || process.env.ALUMNI_ROSTER_PATH || path.join(__dirname, 'data', 'runtime', 'alumni-import.json'),
  );
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(dest, 0o600);
  console.log(`已写入 ${records.length} 条 -> ${dest}`);
  console.log('请运行 npm run migrate-roster 写入目标存储；不要把这个文件提交 Git 或放进镜像。');
  const years = [...new Set(records.map(r => r.cohortYear))].sort();
  console.log('归一化后的年份筛选项:', years.join(', '));
}
main();
