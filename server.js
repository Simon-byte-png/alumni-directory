'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SearchIndex } = require('./lib/search');
const { cloudBaseBackendFromEnv } = require('./lib/state-backends');
const { AnalyticsStore } = require('./lib/analytics');
const {
  AuthStore,
  LoginLimiter,
  MAX_REGISTRATION_FAILURES,
  normalizeUsername,
  publicUser,
} = require('./lib/auth');
const CONFIG = require('./config');

const USER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_LEASE_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const REGISTRATION_RATE_WINDOW_MS = 60 * 60 * 1000;
const REGISTRATION_IP_LIMIT = 200;
const REGISTRATION_GLOBAL_LIMIT = 500;
const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...NO_CACHE,
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(JSON.stringify(value));
}

function apiError(res, status, message, code = 'request_failed', extra = {}) {
  return json(res, status, { ok: false, error: message, code, ...extra });
}

function csvCell(value) {
  let text = String(value == null ? '' : value);
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const ROSTER_PROFILE_FIELDS = [
  'name', 'edu', 'cohort', 'status', 'industry', 'org', 'doing', 'city',
  'willingContact', 'contact', 'offer', 'want', 'hiring', 'message',
  'cohortYear', 'cityNorm', 'experiences',
];
const EXPERIENCE_FIELDS = ['status', 'industry', 'org', 'doing', 'city'];
const PRIVATE_PROFILE_FIELDS = [
  'name', 'edu', 'cohort', 'status', 'industry', 'org', 'doing', 'city',
  'willingContact', 'contact', 'offer', 'want', 'hiring', 'message',
];

function canonicalRosterName(value) {
  const original = String(value || '').trim();
  const withoutAlias = original.replace(/[（(][^）)]*[）)]/g, '');
  const chinesePart = withoutAlias.replace(/[A-Za-z]/g, '').replace(/[\s·•,，、]+/g, '').trim();
  return (chinesePart || original).toLocaleLowerCase('zh-CN');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        const error = new Error('请求内容过大');
        error.status = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid object');
        resolve(parsed);
      }
      catch (_) {
        const error = new Error('请求格式不正确');
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function buildData(raw, logger, source = 'file', mtime = null) {
  raw.records = Array.isArray(raw.records) ? raw.records : [];
  raw.records.forEach((record, index) => {
    if (!record.id) record.id = 'a' + String(index + 1).padStart(4, '0');
  });
  if (logger) logger.log(`已从${source === 'database' ? '数据库' : '文件'}加载 ${raw.records.length} 条校友数据`);
  return {
    raw,
    index: new SearchIndex(raw.records),
    mtime,
    source,
  };
}

function loadData(dataPath, logger) {
  const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  return buildData(raw, logger, 'file', fs.statSync(dataPath).mtimeMs);
}

function loadStoredData(records, logger) {
  return buildData({ _note: 'CloudBase 私有校友基线', records }, logger, 'database');
}

function loadSessionSecret(stateDir, supplied) {
  if (supplied) {
    const secret = String(supplied);
    if (Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error('ALUMNI_SESSION_SECRET 至少需要 32 字节');
    }
    return secret;
  }
  const secretPath = path.join(stateDir, 'session.key');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try { return fs.readFileSync(secretPath, 'utf8').trim(); }
  catch (_) {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, secret, { encoding: 'utf8', mode: 0o600 });
    return secret;
  }
}

function createSessionCodec(secret, now = () => Date.now()) {
  function sign(user) {
    const activeSession = user.activeSession;
    if (!activeSession) throw new Error('账号没有有效登录状态');
    const payload = Buffer.from(JSON.stringify({
      sub: user.id,
      role: user.role,
      ver: user.tokenVersion,
      sid: activeSession.id,
      exp: activeSession.tokenExpiresAt,
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function verify(token) {
    if (!token) return null;
    const parts = String(token).split('.');
    if (parts.length !== 2) return null;
    const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
    const actualBuffer = Buffer.from(parts[1]);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      return payload.exp > now() ? payload : null;
    } catch (_) { return null; }
  }

  return { sign, verify };
}

function tokenFromRequest(req) {
  const authorization = String(req.headers.authorization || '');
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  return String(req.headers['x-alumni-token'] || '');
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function contactable(record) {
  const willing = String(record.willingContact || '').trim();
  if (!willing || /不|否|拒绝|暂|no/i.test(willing)) return false;
  return /愿意|可以|方便|yes|ok|可/i.test(willing) && !!String(record.contact || '').trim();
}

function publicView(record) {
  const view = { id: record.id };
  if (CONFIG.contactEnabled) view.contactable = contactable(record);
  for (const field of CONFIG.publicFields) view[field] = record[field] || '';
  const allowedExperienceFields = EXPERIENCE_FIELDS.filter(field => CONFIG.publicFields.includes(field));
  const source = Array.isArray(record.experiences) && (record.experiences.length || record.userId)
    ? record.experiences
    : [{ ...record, id: `${record.id || 'record'}-current`, recordedMonth: '', recordedAt: '', isCurrent: true }];
  view.experiences = source.map(item => ({
    id: String(item.id || ''),
    recordedMonth: /^\d{4}-(0[1-9]|1[0-2])$/.test(String(item.recordedMonth || ''))
      ? item.recordedMonth
      : (record.createdAt ? String(record.createdAt).slice(0, 7) : ''),
    isCurrent: item.isCurrent !== false,
    ...Object.fromEntries(allowedExperienceFields.map(field => [field, String(item[field] || '')])),
  })).filter(item => allowedExperienceFields.some(field => item[field]));
  return view;
}

function facets(records) {
  const output = {};
  for (const field of CONFIG.facetFields) {
    if (!CONFIG.publicFields.includes(field)) continue;
    const values = [...new Set(records.map(record => record[field]).filter(Boolean))];
    if (field === 'cohortYear') {
      values.sort((a, b) => {
        const aNumber = /^\d+$/.test(a);
        const bNumber = /^\d+$/.test(b);
        if (aNumber && bNumber) return Number(b) - Number(a);
        if (aNumber) return -1;
        if (bNumber) return 1;
        return String(a).localeCompare(String(b), 'zh');
      });
    } else values.sort((a, b) => String(a).localeCompare(String(b), 'zh'));
    output[field] = values;
  }
  return output;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function serveStatic(publicDir, req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return apiError(res, 405, '请求方法不支持', 'method_not_allowed');
  const relative = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname;
  const filePath = path.join(publicDir, path.normalize(relative).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(publicDir)) return apiError(res, 403, '禁止访问', 'forbidden');
  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...NO_CACHE });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      ...NO_CACHE,
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    res.end(buffer);
  });
}

async function createApp(options = {}) {
  const rootDir = options.rootDir || __dirname;
  const publicDir = options.publicDir || path.join(rootDir, 'public');
  const stateDir = options.stateDir || process.env.ALUMNI_STATE_DIR || path.join(rootDir, 'data', 'runtime');
  const rosterReviewPath = options.rosterReviewPath
    || process.env.ALUMNI_ROSTER_REVIEW_PATH
    || path.join(stateDir, 'pending-account-review.json');
  const storageDriver = options.storageDriver || process.env.ALUMNI_STORAGE_DRIVER || 'json';
  if (!['json', 'cloudbase'].includes(storageDriver)) throw new Error('ALUMNI_STORAGE_DRIVER 只支持 json 或 cloudbase');
  const suppliedSessionSecret = options.sessionSecret || process.env.ALUMNI_SESSION_SECRET;
  if (storageDriver === 'cloudbase' && !suppliedSessionSecret) {
    throw new Error('CloudBase 部署必须配置固定的 ALUMNI_SESSION_SECRET');
  }
  const secret = loadSessionSecret(stateDir, suppliedSessionSecret);
  const dataPath = options.dataPath || process.env.ALUMNI_ROSTER_PATH || path.join(stateDir, 'alumni-import.json');
  const stateBackend = options.stateBackend === undefined
    ? (storageDriver === 'cloudbase' ? cloudBaseBackendFromEnv() : null)
    : options.stateBackend;
  const seedPath = options.seedPath === null ? null : (options.seedPath || path.join(stateDir, 'account-seed.json'));
  const questionSeedPath = options.questionSeedPath === null
    ? null
    : (options.questionSeedPath || path.join(stateDir, 'question-seed.json'));
  const logger = options.logger === undefined ? console : options.logger;
  const trustProxy = options.trustProxy === undefined ? process.env.TRUST_PROXY === '1' : options.trustProxy;
  const now = options.now || (() => Date.now());
  const store = options.store || await new AuthStore({
    statePath: path.join(stateDir, 'auth-state.json'),
    stateBackend,
    seedPath,
    questionSeedPath,
    scryptCost: options.scryptCost,
    now,
    randomInt: options.randomInt,
  }).init();
  const analyticsBackend = options.analyticsBackend === undefined
    ? (storageDriver === 'cloudbase' ? cloudBaseBackendFromEnv({ documentId: 'analytics' }) : null)
    : options.analyticsBackend;
  const analyticsStore = options.analyticsStore || await new AnalyticsStore({
    statePath: path.join(stateDir, 'analytics-state.json'),
    stateBackend: analyticsBackend,
    now,
  }).init();
  // Every deployment/restart creates a fresh archive before serving requests.
  // Startup fails visibly if durable backup verification is unavailable.
  if (store.stateBackend?.archiveCurrent) await store.stateBackend.archiveCurrent();
  if (analyticsStore.stateBackend?.archiveCurrent) await analyticsStore.stateBackend.archiveCurrent();
  const bootstrapPassword = options.adminBootstrapPassword || process.env.ALUMNI_ADMIN_BOOTSTRAP_PASSWORD || '';
  if (bootstrapPassword) {
    if (String(bootstrapPassword).length < 12) throw new Error('ALUMNI_ADMIN_BOOTSTRAP_PASSWORD 至少需要 12 个字符');
    await store.ensureAdmin({
      username: options.adminBootstrapUsername || process.env.ALUMNI_ADMIN_USERNAME || 'admin',
      displayName: options.adminBootstrapName || process.env.ALUMNI_ADMIN_NAME || '管理员',
      password: bootstrapPassword,
    });
  }
  const sessions = createSessionCodec(secret, now);
  const loginLimiter = new LoginLimiter({ now });
  let activeAuthentications = 0;
  const registrationIpLimiter = new LoginLimiter({
    now,
    maxFailures: options.registrationIpLimit || REGISTRATION_IP_LIMIT,
    windowMs: REGISTRATION_RATE_WINDOW_MS,
    blockMs: REGISTRATION_RATE_WINDOW_MS,
  });
  const registrationGlobalLimiter = new LoginLimiter({
    now,
    maxFailures: options.registrationGlobalLimit || REGISTRATION_GLOBAL_LIMIT,
    windowMs: REGISTRATION_RATE_WINDOW_MS,
    blockMs: REGISTRATION_RATE_WINDOW_MS,
  });
  const visitLimiter = new LoginLimiter({
    now, maxFailures: 1000, windowMs: 60 * 60 * 1000, blockMs: 60 * 60 * 1000,
  });
  let rosterReview = store.listRosterReview();
  if (!rosterReview.pending.length) {
    try {
      const rawRosterReview = JSON.parse(fs.readFileSync(rosterReviewPath, 'utf8'));
      if (Array.isArray(rawRosterReview)) rosterReview = { pending: rawRosterReview };
      else if (Array.isArray(rawRosterReview.pending)) rosterReview = rawRosterReview;
    } catch (_) {
      // The review list is optional in minimal/test deployments.
    }
  }
  const storedRoster = store.listRosterRecords();
  let alumniFile;
  if (storedRoster.length) {
    alumniFile = loadStoredData(storedRoster, logger);
  } else if (storageDriver === 'cloudbase') {
    throw new Error('CloudBase 中尚无校友基线，请先运行 npm run migrate-roster');
  } else if (fs.existsSync(dataPath)) {
    alumniFile = loadData(dataPath, logger);
  } else {
    const examplePath = path.join(rootDir, 'data', 'alumni.example.json');
    alumniFile = loadData(examplePath, logger);
  }
  let alumni;

  function rebuildAlumni() {
    const profiles = store.listProfiles();
    const replacedIds = new Set(profiles.map(profile => profile.baseRecordId).filter(Boolean));
    const replacedNames = new Set(profiles
      .filter(profile => !profile.baseRecordId)
      .map(profile => canonicalRosterName(profile.name)).filter(Boolean));
    const records = [
      ...alumniFile.raw.records.filter(record => (
        !replacedIds.has(record.id) && !replacedNames.has(canonicalRosterName(record.name))
      )),
      ...profiles,
    ];
    alumni = {
      raw: { ...alumniFile.raw, records },
      index: new SearchIndex(records),
      mtime: alumniFile.mtime,
    };
  }

  rebuildAlumni();

  function refreshAlumni() {
    if (alumniFile.source !== 'file') {
      rebuildAlumni();
      return;
    }
    try {
      const mtime = fs.statSync(dataPath).mtimeMs;
      if (mtime !== alumniFile.mtime) alumniFile = loadData(dataPath, logger);
    } catch (_) { /* 保留上一份已加载数据 */ }
    rebuildAlumni();
  }

  function sourceProfileForUser(user) {
    const saved = store.findProfileByUserId(user.id);
    if (saved) return saved;
    return alumniFile.raw.records.find(record => (
      canonicalRosterName(record.name) === canonicalRosterName(user.displayName)
    )) || null;
  }

  function privateProfileView(user, record) {
    const source = record || {};
    const output = {
      username: user.username,
      ...Object.fromEntries(PRIVATE_PROFILE_FIELDS.map(field => [field, String(source[field] || '')])),
    };
    output.name = user.displayName;
    const experiences = Array.isArray(source.experiences) && (source.experiences.length || source.userId)
      ? source.experiences
      : (EXPERIENCE_FIELDS.some(field => source[field]) ? [{
        id: `${source.id || user.id}-current`,
        ...Object.fromEntries(EXPERIENCE_FIELDS.map(field => [field, String(source[field] || '')])),
        recordedMonth: user.profileFirstFilledMonth || (source.createdAt ? String(source.createdAt).slice(0, 7) : ''),
        recordedAt: source.createdAt || '',
        isCurrent: true,
      }] : []);
    output.experiences = experiences.map(item => ({
      id: String(item.id || ''),
      ...Object.fromEntries(EXPERIENCE_FIELDS.map(field => [field, String(item[field] || '')])),
      recordedMonth: /^\d{4}-(0[1-9]|1[0-2])$/.test(String(item.recordedMonth || '')) ? item.recordedMonth : '',
      isCurrent: item.isCurrent !== false,
    }));
    output.updatedAt = source.updatedAt || '';
    return output;
  }

  function buildRosterRows() {
    const usedRecordIds = new Set();
    const recordsByName = new Map();
    for (const record of alumni.raw.records) {
      const key = canonicalRosterName(record.name);
      if (!recordsByName.has(key)) recordsByName.set(key, []);
      recordsByName.get(key).push(record);
    }
    const profileFor = displayName => {
      const candidates = recordsByName.get(canonicalRosterName(displayName)) || [];
      const profile = candidates.find(item => !usedRecordIds.has(item.id));
      if (profile) usedRecordIds.add(profile.id);
      return profile || null;
    };
    const withProfile = (base, profile) => {
      const output = { ...base };
      for (const field of ROSTER_PROFILE_FIELDS) output[field] = profile?.[field] || output[field] || '';
      output.profileId = profile?.id || '';
      output.profileCreatedAt = profile?.createdAt || '';
      output.profileUpdatedAt = profile?.updatedAt || '';
      return output;
    };
    const users = store.listUsers().filter(user => user.role !== 'admin');
    const accountRows = users.map(user => withProfile({
      ...user,
      displayName: user.displayName,
      accountUsername: user.username,
      accountStatus: user.active ? '已启用' : '已停用',
      passwordStatus: user.passwordChanged ? '已改密码' : '仍用初始密码',
      rosterStatus: 'account',
      reviewReasons: [],
    }, profileFor(user.displayName)));
    const pendingRows = (rosterReview.pending || []).map(item => withProfile({
      row: item.row,
      displayName: item.displayName || '',
      username: item.username || '',
      accountUsername: item.username || '',
      accountStatus: '未开户',
      passwordStatus: '—',
      active: false,
      passwordChanged: false,
      reasons: Array.isArray(item.reasons) ? item.reasons : [],
      reviewReasons: Array.isArray(item.reasons) ? item.reasons : [],
      rosterStatus: 'pending',
    }, profileFor(item.displayName)));
    return [...accountRows, ...pendingRows];
  }

  function rosterMatches(row, query) {
    if (!query) return true;
    return [
      row.displayName, row.username, row.cohort, row.edu, row.status, row.industry,
      row.org, row.doing, row.city, row.offer, row.want, row.hiring, row.message,
      row.contact,
    ].some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
  }

  function sessionUser(req) {
    const payload = sessions.verify(tokenFromRequest(req));
    if (!payload) return null;
    const user = store.findUserById(payload.sub);
    if (!user || !user.active || user.tokenVersion !== payload.ver || user.role !== payload.role) return null;
    if (!user.activeSession || user.activeSession.id !== payload.sid || user.activeSession.expiresAt <= now()) return null;
    return user;
  }

  function requireUser(req, res) {
    const user = sessionUser(req);
    if (!user) {
      apiError(res, 401, '请先登录', 'unauthorized', { needAuth: true });
      return null;
    }
    return user;
  }

  function requireAdmin(req, res) {
    const user = requireUser(req, res);
    if (!user) return null;
    if (user.role !== 'admin') {
      apiError(res, 403, '需要管理员权限', 'forbidden');
      return null;
    }
    return user;
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const ip = clientIp(req, trustProxy);
    if (pathname.startsWith('/api/') && !['/api/visit', '/api/auth/login', '/api/register/start', '/api/register/submit'].includes(pathname)) {
      // Anonymous and invalid-token requests need no private database read.
      if (sessions.verify(tokenFromRequest(req))) await store.refreshFromBackend();
      refreshAlumni();
    }

    if (pathname === '/health' || pathname === '/api/health') {
      return json(res, 200, { ok: true, total: alumni.raw.records.length, accountCount: store.state.users.length });
    }

    if (pathname === '/api/config' && req.method === 'GET') {
      const activeQuestionCount = store.activeQuestions().length;
      return json(res, 200, {
        ok: true,
        activeQuestionCount,
        registrationAvailable: activeQuestionCount >= 3,
        maxRegistrationFailures: MAX_REGISTRATION_FAILURES,
        helpText: '不确定答案时，请询问管理员。',
      });
    }

    if (pathname === '/api/visit' && req.method === 'POST') {
      if (!visitLimiter.check(ip, 'visit').allowed) return apiError(res, 429, '访问统计请求过于频繁', 'rate_limited');
      visitLimiter.fail(ip, 'visit');
      const body = await readJson(req);
      await analyticsStore.recordVisit(body.visitorId);
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/admin/analytics' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, { ok: true, analytics: await analyticsStore.freshSummary() });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readJson(req);
      const username = normalizeUsername(body.username);
      const limit = loginLimiter.check(ip, username);
      if (!limit.allowed) {
        return apiError(res, 429, '尝试次数过多，请稍后再试', 'login_rate_limited', {
          retryAfterSeconds: Math.ceil(limit.retryAfterMs / 1000),
        });
      }
      if (activeAuthentications >= 8) return apiError(res, 429, '当前登录请求较多，请稍后再试', 'login_busy');
      // Reserve the attempt before asynchronous password hashing starts.
      loginLimiter.fail(ip, username);
      let user;
      activeAuthentications++;
      try {
        await store.refreshFromBackend();
        user = await store.authenticate(username, body.password);
      }
      finally { activeAuthentications--; }
      if (!user) {
        return apiError(res, 401, '账号或密码不正确', 'invalid_credentials');
      }
      loginLimiter.clear(ip, username);
      let signedIn;
      let profileReminder;
      try {
        ({ user: signedIn, profileReminder } = await store.claimSession(
          user.id, user.role === 'admin' ? ADMIN_TOKEN_TTL_MS : USER_TOKEN_TTL_MS,
          SESSION_LEASE_MS, user.passwordHash, String(body.takeOverSessionId || ''),
        ));
      } catch (error) {
        if (error.code !== 'account_in_use') throw error;
        return apiError(res, 409, error.message, error.code, {
          canTakeOver: error.canTakeOver,
          retryAfterSeconds: error.retryAfterSeconds,
          ...(error.canTakeOver ? { takeOverSessionId: error.takeOverSessionId } : {}),
        });
      }
      return json(res, 200, { ok: true, token: sessions.sign(signedIn), user: publicUser(signedIn), profileReminder });
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const user = requireUser(req, res);
      if (!user) return;
      await store.releaseSession(user.id, user.activeSession.id);
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/auth/heartbeat' && req.method === 'POST') {
      const user = requireUser(req, res);
      if (!user) return;
      await store.renewSession(user.id, user.activeSession.id, SESSION_LEASE_MS);
      return json(res, 200, { ok: true });
    }

    if ((pathname === '/api/auth/session' || pathname === '/api/auth/check') && req.method === 'GET') {
      const user = sessionUser(req);
      return json(res, 200, user ? { ok: true, user: publicUser(user) } : { ok: false });
    }

    if (pathname === '/api/auth/change-password' && req.method === 'POST') {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      const updated = await store.changePassword(user.id, body.oldPassword, body.newPassword, user.activeSession.id);
      return json(res, 200, { ok: true, token: sessions.sign(updated), user: publicUser(updated) });
    }

    if (pathname === '/api/profile' && req.method === 'GET') {
      const user = requireUser(req, res);
      if (!user) return;
      return json(res, 200, { ok: true, profile: privateProfileView(user, sourceProfileForUser(user)) });
    }

    if (pathname === '/api/profile' && req.method === 'PATCH') {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      const baseProfile = alumniFile.raw.records.find(record => (
        canonicalRosterName(record.name) === canonicalRosterName(user.displayName)
      )) || {};
      const updated = await store.updateOwnProfile(user.id, body, baseProfile, user.activeSession.id);
      rebuildAlumni();
      return json(res, 200, { ok: true, profile: privateProfileView(user, updated) });
    }

    const experienceMatch = pathname.match(/^\/api\/profile\/experiences\/([^/]+)$/);
    if (experienceMatch && req.method === 'DELETE') {
      const user = requireUser(req, res);
      if (!user) return;
      const updated = await store.deleteOwnExperience(user.id, decodeURIComponent(experienceMatch[1]), user.activeSession.id);
      rebuildAlumni();
      return json(res, 200, { ok: true, profile: privateProfileView(user, updated) });
    }

    if (pathname === '/api/register/start' && req.method === 'POST') {
      const ipLimit = registrationIpLimiter.check(ip, 'registration-start');
      const globalLimit = registrationGlobalLimiter.check('all-clients', 'registration-start');
      if (!ipLimit.allowed || !globalLimit.allowed) {
        return apiError(res, 429, '当前注册请求较多，请稍后再试', 'registration_rate_limited', {
          retryAfterMs: Math.max(ipLimit.retryAfterMs || 0, globalLimit.retryAfterMs || 0),
        });
      }
      registrationIpLimiter.fail(ip, 'registration-start');
      registrationGlobalLimiter.fail('all-clients', 'registration-start');
      const body = await readJson(req);
      try {
        await store.refreshFromBackend();
        const registration = await store.beginRegistration({
          ip,
          profile: body.profile,
        });
        return json(res, 200, { ok: true, ...registration });
      } catch (error) {
        const status = error.status || (error.code === 'registration_locked' ? 423
          : error.code === 'registration_busy' ? 429
            : ['account_exists', 'registration_in_progress', 'username_conflict'].includes(error.code) ? 409 : 400);
        return apiError(res, status, error.message, error.code || 'registration_unavailable');
      }
    }

    if (pathname === '/api/register/submit' && req.method === 'POST') {
      const body = await readJson(req);
      if (store.quizSessions.has(String(body.attemptId || ''))) await store.refreshFromBackend();
      const result = await store.submitRegistration({ ip, attemptId: body.attemptId, answers: body.answers });
      if (!result.passed) {
        return json(res, 200, {
          ok: true,
          passed: false,
          locked: result.locked,
          attemptsUsed: result.attemptsUsed,
          attemptsRemaining: result.attemptsRemaining,
          message: result.locked
            ? '已连续答错 5 次，该姓名的自助注册锁定 1 小时；如需提前解锁，请联系管理员。'
            : `本轮没有全部答对，还剩 ${result.attemptsRemaining} 次机会。`,
        });
      }
      return json(res, 201, {
        ok: true,
        passed: true,
        username: result.user.username,
        initialPassword: result.user.username,
        message: '注册成功，账号和初始密码均为姓名拼音。',
      });
    }

    if (pathname === '/api/admin/users' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, { ok: true, users: store.listUsers() });
    }

    if (pathname === '/api/admin/roster' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const query = String(url.searchParams.get('q') || '').trim().toLocaleLowerCase('zh-CN');
      const status = String(url.searchParams.get('status') || '').trim();
      const allRows = buildRosterRows();
      const rows = allRows.filter(row => (!status || row.rosterStatus === status) && rosterMatches(row, query));
      const accountCount = allRows.filter(row => row.rosterStatus === 'account').length;
      const pendingCount = allRows.filter(row => row.rosterStatus === 'pending').length;
      return json(res, 200, {
        ok: true,
        total: allRows.length,
        accountCount,
        pendingCount,
        rows,
      });
    }

    if (pathname === '/api/admin/roster.csv' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const rows = buildRosterRows();
      const columns = [
        ['姓名', 'displayName'], ['账号', 'accountUsername'], ['院系/校友身份', 'edu'], ['届别', 'cohort'],
        ['当前状态', 'status'], ['行业/方向', 'industry'], ['公司/机构', 'org'], ['目前在做的事', 'doing'],
        ['所在城市', 'city'], ['是否愿意被联系', 'willingContact'], ['联系方式', 'contact'],
        ['可以提供的帮助', 'offer'], ['希望获得的帮助', 'want'], ['招聘/合作需求', 'hiring'],
        ['想说的话', 'message'], ['账号状态', 'accountStatus'], ['密码状态', 'passwordStatus'],
        ['名单状态', 'rosterStatus'], ['核对备注', 'reviewReasons'],
      ];
      const headers = columns.map(item => item[0]);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="alumni-roster-${new Date().toISOString().slice(0, 10)}.csv"`,
        ...NO_CACHE,
        ...SECURITY_HEADERS,
      });
      const lines = [headers.map(csvCell).join(',')];
      for (const row of rows) lines.push(columns.map(([, key]) => csvCell(Array.isArray(row[key]) ? row[key].join('；') : row[key])).join(','));
      return res.end(`\ufeff${lines.join('\r\n')}\r\n`);
    }

    if (pathname === '/api/admin/profiles' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, { ok: true, profiles: store.listProfilesForAdmin() });
    }

    if (pathname === '/api/admin/registrations' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, {
        ok: true,
        maxRegistrationFailures: MAX_REGISTRATION_FAILURES,
        submissions: store.listRegistrationSubmissionsForAdmin({
          status: url.searchParams.get('status') || '',
          query: url.searchParams.get('q') || '',
        }),
      });
    }

    if (pathname === '/api/admin/registrations.csv' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const rows = store.listRegistrationSubmissionsForAdmin({
        status: url.searchParams.get('status') || '',
        query: url.searchParams.get('q') || '',
      });
      const headers = [
        ['status', '审核状态'], ['name', '姓名'], ['cohort', '届别'],
        ['edu', '院系/校友身份'], ['statusText', '当前状态'], ['industry', '行业/方向'],
        ['org', '公司/机构'], ['doing', '目前在做的事'], ['city', '所在城市'],
        ['willingContact', '是否愿意被联系'], ['contact', '联系方式'],
        ['offer', '可以提供的帮助'], ['want', '希望获得的帮助'],
        ['hiring', '招聘/合作需求'], ['message', '想说的话'],
        ['attemptsUsed', '答题次数'], ['username', '账号'], ['createdAt', '提交时间'],
        ['reviewedAt', '审核时间'], ['reviewerNote', '审核备注'],
      ];
      const lines = [headers.map(([, label]) => csvCell(label)).join(',')];
      for (const row of rows) {
        const profile = row.profile || {};
        lines.push(headers.map(([key]) => csvCell(key === 'statusText' ? profile.status : (row[key] ?? profile[key]))).join(','));
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="alumni-registration-${new Date().toISOString().slice(0, 10)}.csv"`,
        ...NO_CACHE,
        ...SECURITY_HEADERS,
      });
      return res.end(`\ufeff${lines.join('\r\n')}\r\n`);
    }

    const registrationMatch = pathname.match(/^\/api\/admin\/registrations\/([^/]+)$/);
    if (registrationMatch && req.method === 'PATCH') {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = await readJson(req);
      const id = decodeURIComponent(registrationMatch[1]);
      try {
        if (body.action === 'approve') {
          const user = await store.approveRegistration(id, admin, body.note || '');
          return json(res, 200, { ok: true, action: 'approved', user: publicUser(user) });
        }
        if (body.action === 'reject') {
          const submission = await store.updateRegistrationSubmissionStatus(id, 'rejected', admin, body.note || '');
          return json(res, 200, { ok: true, action: 'rejected', submission: { id: submission.id, status: submission.status } });
        }
        if (body.action === 'restore') {
          const submission = await store.updateRegistrationSubmissionStatus(id, 'pending', admin, body.note || '');
          return json(res, 200, { ok: true, action: 'restored', submission: { id: submission.id, status: submission.status } });
        }
        return apiError(res, 400, '不支持的审核操作', 'invalid_action');
      } catch (error) {
        return apiError(res, error.code === 'username_conflict' ? 409 : 400, error.message, error.code || 'registration_review_failed');
      }
    }

    if (pathname === '/api/admin/users' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const user = await store.createUser({
        displayName: body.displayName,
        cohort: body.cohort,
        username: body.username,
        source: 'admin',
      });
      return json(res, 201, { ok: true, user: publicUser(user), initialPassword: user.username });
    }

    const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userMatch && req.method === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      try {
        const user = await store.deleteUser(decodeURIComponent(userMatch[1]));
        return json(res, 200, { ok: true, user: publicUser(user) });
      } catch (error) {
        const status = error.status || (error.code === 'user_not_found' ? 404 : error.code === 'cannot_delete_admin' ? 409 : 400);
        return apiError(res, status, error.message, error.code || 'delete_user_failed');
      }
    }
    if (userMatch && req.method === 'PATCH') {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const id = decodeURIComponent(userMatch[1]);
      if (body.releaseSession) {
        await store.clearSession(id);
        return json(res, 200, { ok: true });
      }
      const user = await store.updateUser(id, body);
      return json(res, 200, {
        ok: true,
        user: publicUser(user),
        resetPassword: body.resetPassword ? user.username : undefined,
      });
    }

    if (pathname === '/api/admin/questions' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, { ok: true, questions: store.listQuestions(true) });
    }

    if (pathname === '/api/admin/questions' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const question = await store.createQuestion(await readJson(req));
      return json(res, 201, { ok: true, question });
    }

    const questionMatch = pathname.match(/^\/api\/admin\/questions\/([^/]+)$/);
    if (questionMatch && req.method === 'PATCH') {
      if (!requireAdmin(req, res)) return;
      const question = await store.updateQuestion(decodeURIComponent(questionMatch[1]), await readJson(req));
      return json(res, 200, { ok: true, question });
    }

    if (pathname === '/api/admin/locks' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, {
        ok: true,
        maxRegistrationFailures: MAX_REGISTRATION_FAILURES,
        activity: store.listRegistrationActivity(),
      });
    }

    const lockMatch = pathname.match(/^\/api\/admin\/locks\/([^/]+)$/);
    if (lockMatch && req.method === 'DELETE') {
      if (!requireAdmin(req, res)) return;
      await store.unlockRegistration(decodeURIComponent(lockMatch[1]));
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/meta' && req.method === 'GET') {
      if (!requireUser(req, res)) return;
      return json(res, 200, {
        total: alumni.raw.records.length,
        isSample: /示例数据/.test(alumni.raw._note || ''),
        facets: facets(alumni.raw.records),
      });
    }

    if (pathname === '/api/search' && req.method === 'GET') {
      if (!requireUser(req, res)) return;
      const query = url.searchParams.get('q') || '';
      const cohortYear = url.searchParams.get('cohortYear') || '';
      const cityNorm = url.searchParams.get('cityNorm') || '';
      const hits = query.trim()
        ? alumni.index.search(query, { limit: 60 })
        : alumni.raw.records.map((_, index) => ({ index, score: 0, relevance: 0, reasons: [] }));
      const items = [];
      for (const hit of hits) {
        const record = alumni.raw.records[hit.index];
        if (cohortYear && record.cohortYear !== cohortYear) continue;
        if (cityNorm && record.cityNorm !== cityNorm) continue;
        items.push(publicView(record));
      }
      return json(res, 200, { count: items.length, items });
    }

    if (pathname.startsWith('/api/contact/') && req.method === 'GET') {
      if (!requireUser(req, res)) return;
      if (!CONFIG.contactEnabled) return apiError(res, 403, '联系方式功能未启用', 'disabled');
      const id = decodeURIComponent(pathname.slice('/api/contact/'.length));
      const record = alumni.raw.records.find(item => item.id === id);
      if (!record) return apiError(res, 404, '未找到该校友', 'not_found');
      if (!contactable(record)) {
        return json(res, 200, {
          ok: false,
          blocked: true,
          message: '该校友没有授权直接联系，请通过管理员转达。',
        });
      }
      return json(res, 200, { ok: true, name: record.name, contact: record.contact || '（未填写）' });
    }

    if (pathname.startsWith('/api/')) return apiError(res, 404, '接口不存在', 'not_found');
    return serveStatic(publicDir, req, res, pathname);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (logger) logger.error(error);
      if (res.headersSent) return res.end();
      apiError(res, error.status || 400, error.message || '服务器处理失败', error.code || 'request_failed');
    });
  });

  return { server, store, analyticsStore, sessions };
}

async function start() {
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || process.env.ZAOCODE_PREVIEW_PORT || 3000);
  const { server } = await createApp();
  server.listen(port, host, () => console.log(`校友通讯录已启动：http://${host}:${port}`));
}

if (require.main === module) {
  start().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  createApp,
  createSessionCodec,
  clientIp,
};
