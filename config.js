'use strict';
/*
 * 隐私配置 —— 想调整哪些栏公开，只改这里一处即可。
 * publicFields：会【展示 + 参与检索】的字段。
 * 未列入 publicFields 的字段（offer/contact/willingContact）：
 *   不向其他普通成员展示，也不参与公开检索；本人资料和管理员后台仍可查看。
 *   其中 contact 仅通过「申请查看联系方式」单独获取，willingContact 仅用于后台判断是否放行。
 *
 * 全部可选字段：name 姓名 / edu 院系校区 / cohort 届别 / status 当前状态 /
 *   industry 行业方向 / org 公司机构 / doing 在做的事 / city 城市 /
 *   offer 可提供 / want 希望获得 / hiring 招聘合作需求 / message 寄语 /
 *   willingContact 是否愿意被联系 / contact 联系方式
 */
module.exports = {
  // 第一版：彻底隐藏联系方式 —— 不显示申请按钮，普通检索接口不返回联系方式；本人资料和管理员后台可查看
  contactEnabled: false,

  publicFields: [
    'name',       // 姓名
    'edu',        // 院系/校友身份
    'cohort',     // 届别（原始文字，用于展示）
    'cohortYear', // 入学年份（归一化，用于筛选/检索）
    'status',     // 当前状态
    'industry',   // 当前行业/关注方向
    'org',        // 当前公司/机构
    'doing',      // 目前主要在做的事
    'city',       // 所在城市（原始文字，用于展示）
    'cityNorm',   // 城市归一（用于筛选）
    'want',       // 希望获得
    'hiring',     // 招聘及合作需求
    'message',    // 想说的话
  ],

  // 各字段在检索中的权重（仅对 publicFields 生效，越高越重要）
  fieldWeights: {
    industry: 3.0, doing: 2.6, hiring: 2.6, want: 1.2,
    city: 1.0, cityNorm: 0.8, cohort: 0.6, cohortYear: 0.5, edu: 0.8, message: 0.6,
    // 以下即使写了权重，只要不在 publicFields 里就不会被索引：
    org: 1.6, offer: 1.8, status: 1.0,
  },

  fieldLabels: {
    name: '姓名', edu: '院系', cohort: '届别', cohortYear: '年份', status: '状态',
    industry: '行业/方向', org: '公司/机构', doing: '在做的事', city: '城市', cityNorm: '城市',
    offer: '可提供', want: '希望获得', hiring: '合作需求', message: '寄语',
  },

  // 筛选下拉用哪些字段（也必须在 publicFields 内）
  facetFields: ['cohortYear', 'cityNorm'],
};
