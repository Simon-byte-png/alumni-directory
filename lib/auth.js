'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { pinyin } = require('pinyin-pro');

const scryptAsync = promisify(crypto.scrypt);
const STATE_VERSION = 1;
const QUIZ_TTL_MS = 15 * 60 * 1000;
const MAX_REGISTRATION_FAILURES = 5;
const REGISTRATION_LOCK_TTL_MS = 60 * 60 * 1000;
const MAX_QUIZ_SESSIONS = 1000;
const MAX_PENDING_REGISTRATION_SUBMISSIONS = 1000;
const PENDING_REGISTRATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOGIN_LIMITER_ENTRIES = 10000;
const MAX_PROFILE_EXPERIENCES = 20;
const PROFILE_EDIT_FIELDS = [
  ['edu', '院系/校友身份', 100],
  ['cohort', '届别', 40],
  ['status', '当前状态', 60],
  ['industry', '行业/方向', 120],
  ['org', '公司/机构', 120],
  ['doing', '目前在做的事', 300],
  ['city', '所在城市', 80],
  ['offer', '可以提供的帮助', 300],
  ['want', '希望获得的帮助', 300],
  ['hiring', '招聘/合作需求', 300],
  ['message', '想说的话', 500],
  ['contact', '联系方式', 200],
];
const EXPERIENCE_FIELDS = ['status', 'industry', 'org', 'doing', 'city'];

function cleanName(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalizeUsername(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function usernameFromName(name) {
  const clean = cleanName(name);
  if (!clean) return '';
  const parts = pinyin(clean, {
    toneType: 'none',
    type: 'array',
    nonZh: 'consecutive',
  }) || [];
  return normalizeUsername(parts.join(''));
}

function initialsFromName(name) {
  const parts = pinyin(cleanName(name), {
    toneType: 'none',
    type: 'array',
    nonZh: 'consecutive',
  }) || [];
  return normalizeUsername(parts.map(part => String(part)[0] || '').join(''));
}

function registrationAttemptKey(name) {
  // CloudBase stores this object as BSON, where field names cannot contain NUL.
  // Key by the registration identity so changing networks cannot reset the lock.
  const identity = cleanName(name).toLocaleLowerCase('zh-CN');
  return `name_${crypto.createHash('sha256').update(identity).digest('hex')}`;
}

function limitedText(value, label, maxLength = 200) {
  const text = cleanName(value);
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function cleanProfile(input = {}) {
  const profile = {
    name: limitedText(input.name, '姓名', 40),
    edu: limitedText(input.edu, '院系/校友身份', 100),
    cohort: limitedText(input.cohort, '届别', 40),
    status: limitedText(input.status, '当前状态', 60),
    industry: limitedText(input.industry, '行业/方向', 120),
    org: limitedText(input.org, '公司/机构', 120),
    doing: limitedText(input.doing, '目前在做的事', 300),
    city: limitedText(input.city, '所在城市', 80),
    offer: limitedText(input.offer, '可以提供的帮助', 300),
    want: limitedText(input.want, '希望获得的帮助', 300),
    hiring: limitedText(input.hiring, '招聘/合作需求', 300),
    message: limitedText(input.message, '想说的话', 500),
    contact: limitedText(input.contact, '联系方式', 200),
  };
  const required = [
    ['name', '姓名'], ['edu', '院系/校友身份'], ['cohort', '届别'],
    ['status', '当前状态'], ['industry', '行业/方向'], ['doing', '目前在做的事'],
    ['city', '所在城市'], ['contact', '联系方式'],
  ];
  for (const [field, label] of required) {
    if (!profile[field]) throw new Error(`请填写${label}`);
  }
  if (!/^\p{Script=Han}+(?:·\p{Script=Han}+)*$/u.test(profile.name)) {
    throw new Error('请只填写中文姓名，不要附英文名、数字或空格');
  }
  if (!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(profile.contact)) {
    throw new Error('联系方式至少需要包含一个常用邮箱');
  }
  const willing = input.willingContact === true || /^(愿意|是|yes)$/i.test(cleanName(input.willingContact));
  const unwilling = input.willingContact === false || /^(不愿意|否|no)$/i.test(cleanName(input.willingContact));
  if (!willing && !unwilling) throw new Error('请选择是否愿意被其他校友联系');
  profile.willingContact = willing ? '愿意' : '不愿意';
  const year = profile.cohort.match(/(?:19|20)\d{2}/);
  profile.cohortYear = year ? year[0] : '';
  profile.cityNorm = profile.city.split(/[、，,/&和与]/)[0]
    .replace(/^(浙江|广东|江苏|湖北|四川)/, '').replace(/市$/, '').trim() || profile.city;
  profile.namePinyin = usernameFromName(profile.name);
  profile.nameInitials = initialsFromName(profile.name);
  return profile;
}

function enrichProfile(profile) {
  const output = { ...profile };
  const year = String(output.cohort || '').match(/(?:19|20)\d{2}/);
  output.cohortYear = year ? year[0] : '';
  output.cityNorm = String(output.city || '').split(/[、，,/&和与]/)[0]
    .replace(/^(浙江|广东|江苏|湖北|四川)/, '').replace(/市$/, '').trim() || String(output.city || '');
  output.namePinyin = usernameFromName(output.name);
  output.nameInitials = initialsFromName(output.name);
  return output;
}

function cleanEditableProfile(input = {}, base = {}) {
  const profile = { name: cleanName(base.name) };
  for (const [field, label, maxLength] of PROFILE_EDIT_FIELDS) {
    profile[field] = limitedText(input[field] == null ? base[field] : input[field], label, maxLength);
  }
  const rawWilling = input.willingContact == null ? base.willingContact : input.willingContact;
  const willingText = cleanName(rawWilling);
  if (willingText && !['愿意', '不愿意'].includes(willingText)) {
    throw new Error('请选择是否愿意被其他校友联系');
  }
  profile.willingContact = willingText;
  return enrichProfile(profile);
}

function experienceSnapshot(profile, options = {}) {
  const item = Object.fromEntries(EXPERIENCE_FIELDS.map(field => [field, cleanName(profile[field])]));
  if (!EXPERIENCE_FIELDS.some(field => item[field])) return null;
  return {
    id: options.id || `e${crypto.randomUUID().replace(/-/g, '')}`,
    ...item,
    recordedMonth: options.recordedMonth || '',
    recordedAt: options.recordedAt || '',
    isCurrent: options.isCurrent !== false,
  };
}

function sameExperience(left, right) {
  return EXPERIENCE_FIELDS.every(field => cleanName(left && left[field]) === cleanName(right && right[field]));
}

function shanghaiYearMonth(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date(timestamp));
  const year = parts.find(part => part.type === 'year').value;
  const month = parts.find(part => part.type === 'month').value;
  return `${year}-${month}`;
}

function profileReminderChange(user, timestamp) {
  if (!user || !user.active || user.role === 'admin') return null;
  const firstFilledMonth = user.profileFirstFilledMonth;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(firstFilledMonth || ''))) return null;
  const [firstYear, firstMonth] = firstFilledMonth.split('-').map(Number);
  const [year, month] = shanghaiYearMonth(timestamp).split('-').map(Number);
  const cycle = Math.floor(((year - firstYear) * 12 + month - firstMonth) / 12);
  if (!Number.isFinite(cycle) || cycle < 1) return null;
  const count = user.profileReminderCycle === cycle ? (user.profileReminderLoginCount || 0) : 0;
  if (count >= 5) return null;
  return {
    patch: { profileReminderCycle: cycle, profileReminderLoginCount: count + 1 },
    reminder: { firstFilledMonth, cycle, loginNumber: count + 1, limit: 5 },
  };
}

function requireCurrentSession(user, sessionId, timestamp) {
  if (!sessionId) return;
  if (user.activeSession?.id === sessionId && user.activeSession.expiresAt > timestamp) return;
  const error = new Error('登录已失效，请重新登录');
  error.status = 401;
  error.code = 'session_expired';
  throw error;
}

function defaultState() {
  return {
    version: STATE_VERSION,
    users: [],
    questions: [],
    profiles: [],
    rosterRecords: [],
    rosterMeta: null,
    rosterReview: { pending: [] },
    registrationSubmissions: [],
    registrationAttempts: {},
    registrationLocks: [],
  };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    cohort: user.cohort || '',
    role: user.role,
    active: user.active,
    passwordChanged: !!user.passwordChanged,
    source: user.source || '',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function publicQuestion(question) {
  return {
    id: question.id,
    prompt: question.prompt,
    options: [...question.options],
  };
}

async function hashPassword(password, cost = 16384) {
  const salt = crypto.randomBytes(16);
  const blockSize = 8;
  const parallelization = 1;
  const key = await scryptAsync(String(password), salt, 64, {
    cost,
    blockSize,
    parallelization,
    maxmem: Math.max(32 * 1024 * 1024, 256 * cost * blockSize),
  });
  return [
    'scrypt', cost, blockSize, parallelization,
    salt.toString('base64url'), Buffer.from(key).toString('base64url'),
  ].join('$');
}

async function verifyPassword(password, encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (!cost || !blockSize || !parallelization || expected.length !== 64) return false;
  const actual = Buffer.from(await scryptAsync(String(password), salt, expected.length, {
    cost,
    blockSize,
    parallelization,
    maxmem: Math.max(32 * 1024 * 1024, 256 * cost * blockSize),
  }));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validatePassword(password, username) {
  const value = String(password || '');
  if (!value.trim()) throw new Error('新密码不能全部为空格');
  if (value.length < 8) throw new Error('新密码至少需要 8 个字符');
  if (value.length > 128) throw new Error('新密码不能超过 128 个字符');
  if (normalizeUsername(value) === normalizeUsername(username)) {
    throw new Error('新密码不能与账号相同');
  }
}

function shuffle(items, randomInt = crypto.randomInt) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class AuthStore {
  constructor(options = {}) {
    this.statePath = options.statePath;
    this.stateBackend = options.stateBackend || null;
    this.seedPath = options.seedPath;
    this.questionSeedPath = options.questionSeedPath;
    this.scryptCost = options.scryptCost || 16384;
    this.now = options.now || (() => Date.now());
    this.randomInt = options.randomInt || crypto.randomInt;
    this.maxPendingRegistrationSubmissions = options.maxPendingRegistrationSubmissions
      || MAX_PENDING_REGISTRATION_SUBMISSIONS;
    this.pendingRegistrationTtlMs = options.pendingRegistrationTtlMs || PENDING_REGISTRATION_TTL_MS;
    this.state = defaultState();
    this.quizSessions = new Map();
    this.activeQuizByIp = new Map();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    if (!this.statePath && !this.stateBackend) throw new Error('AuthStore requires statePath or stateBackend');
    let stateExists = false;
    if (this.stateBackend) {
      const raw = await this.stateBackend.load();
      if (raw) {
        this.state = { ...defaultState(), ...raw };
        stateExists = true;
      }
    } else {
      await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      try {
        const raw = JSON.parse(await fs.promises.readFile(this.statePath, 'utf8'));
        this.state = { ...defaultState(), ...raw };
        stateExists = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.state = defaultState();
      }
    }
    if (this.state.version !== STATE_VERSION) throw new Error('不支持的账号数据版本');
    if (!Array.isArray(this.state.registrationSubmissions)) this.state.registrationSubmissions = [];
    if (!Array.isArray(this.state.rosterRecords)) this.state.rosterRecords = [];
    if (!this.state.rosterReview || !Array.isArray(this.state.rosterReview.pending)) {
      this.state.rosterReview = { pending: [] };
    }
    const usersChanged = await this.ensureSeedUsers();
    const questionsChanged = await this.ensureSeedQuestions();
    // Existing members first supplied their information in July 2026.
    // Keep this separate from account creation and subsequent profile edits.
    let remindersChanged = false;
    for (const user of this.state.users) {
      if (user.role !== 'admin' && !user.profileFirstFilledMonth) {
        user.profileFirstFilledMonth = shanghaiYearMonth(this.now());
        remindersChanged = true;
      }
    }
    const changed = usersChanged || questionsChanged || remindersChanged;
    if (changed || !stateExists) await this.save();
    return this;
  }

  async ensureSeedUsers() {
    if (!this.seedPath || !fs.existsSync(this.seedPath)) return false;
    const seed = JSON.parse(await fs.promises.readFile(this.seedPath, 'utf8'));
    const accounts = Array.isArray(seed) ? seed : (seed.accounts || []);
    let changed = false;
    for (const account of accounts) {
      const displayName = cleanName(account.displayName || account.name);
      const username = normalizeUsername(account.username);
      if (!displayName || !username) throw new Error('账号种子包含空姓名或空账号');
      if (this.state.users.some(user => user.username === username)) continue;
      const now = new Date(this.now()).toISOString();
      this.state.users.push({
        id: crypto.randomUUID(),
        username,
        displayName,
        cohort: cleanName(account.cohort),
        role: 'user',
        active: true,
        passwordHash: await hashPassword(username, this.scryptCost),
        passwordChanged: false,
        tokenVersion: 1,
        source: 'seed',
        profileFirstFilledMonth: shanghaiYearMonth(this.now()),
        createdAt: now,
        updatedAt: now,
      });
      changed = true;
    }
    return changed;
  }

  async ensureSeedQuestions() {
    if (!this.questionSeedPath || !fs.existsSync(this.questionSeedPath)) return false;
    const seed = JSON.parse(await fs.promises.readFile(this.questionSeedPath, 'utf8'));
    const questions = Array.isArray(seed) ? seed : (seed.questions || []);
    let changed = false;
    for (const item of questions) {
      const seedId = cleanName(item.id);
      if (!seedId) throw new Error('题库种子包含空题目编号');
      if (this.state.questions.some(question => question.seedId === seedId)) continue;
      const valid = this.validateQuestion(item);
      const now = new Date(this.now()).toISOString();
      this.state.questions.push({
        id: crypto.randomUUID(),
        seedId,
        ...valid,
        active: item.active !== false,
        notes: cleanName(item.notes),
        source: 'seed',
        createdAt: now,
        updatedAt: now,
      });
      changed = true;
    }
    return changed;
  }

  enqueueWrite(operation) {
    const result = this.writeQueue.then(operation);
    // The caller must see this write's failure, but later writes can retry.
    this.writeQueue = result.catch(() => {});
    return result;
  }

  async persistSnapshot(snapshot) {
    if (this.stateBackend) return this.stateBackend.save(snapshot);
    const body = JSON.stringify(snapshot, null, 2) + '\n';
    const tempPath = this.statePath + '.tmp';
    const backupPath = this.statePath + '.bak';
    if (fs.existsSync(this.statePath)) {
      await require('./backups').backupLocalState(this.statePath, JSON.parse(await fs.promises.readFile(this.statePath, 'utf8')));
      await fs.promises.copyFile(this.statePath, backupPath);
      await fs.promises.chmod(backupPath, 0o600);
    }
    await fs.promises.writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tempPath, this.statePath);
    await require('./backups').backupLocalState(this.statePath, snapshot);
  }

  save() {
    // Snapshot when the queued operation executes: an earlier password commit
    // must not be overwritten by a snapshot taken before it completed.
    return this.enqueueWrite(() => this.persistSnapshot(JSON.parse(JSON.stringify(this.state))));
  }

  publishSnapshot(snapshot) {
    // Preserve identities held by pending authentication calls while publishing
    // every collection from the same committed snapshot.
    for (const field of ['users', 'questions', 'profiles', 'registrationSubmissions']) {
      const current = new Map(this.state[field].map(item => [item.id, item]));
      snapshot[field] = snapshot[field].map(item => {
        const existing = current.get(item.id);
        if (!existing) return item;
        for (const key of Object.keys(existing)) {
          if (!Object.hasOwn(item, key)) delete existing[key];
        }
        return Object.assign(existing, item);
      });
    }
    Object.assign(this.state, snapshot);
  }

  refreshFromBackend() {
    if (!this.stateBackend) return Promise.resolve();
    return this.enqueueWrite(async () => {
      const raw = await this.stateBackend.load();
      if (!raw || raw.version !== STATE_VERSION) {
        const error = new Error('账号数据暂时无法读取，请稍后重试');
        error.status = 503;
        throw error;
      }
      this.publishSnapshot({ ...defaultState(), ...raw });
    });
  }

  commitMutation(operation) {
    return this.enqueueWrite(async () => {
      // Run legacy multi-step operations on a private draft. Nested save() and
      // createUser() calls cannot publish intermediate accounts or approvals.
      const draft = Object.create(this);
      draft.mutationDraft = true;
      draft.state = structuredClone(this.state);
      draft.quizSessions = structuredClone(this.quizSessions);
      draft.activeQuizByIp = new Map(this.activeQuizByIp);
      draft.writeQueue = Promise.resolve();
      draft.persistSnapshot = async () => {};
      const result = await operation(draft);
      try {
        await this.persistSnapshot(draft.state);
      } catch (cause) {
        if (cause.code === 'backup_unconfirmed' || cause.code === 'state_conflict') throw cause;
        const error = new Error('数据暂时无法保存，请稍后重试', { cause });
        error.status = 503;
        throw error;
      }
      this.publishSnapshot(draft.state);
      this.quizSessions = draft.quizSessions;
      this.activeQuizByIp = draft.activeQuizByIp;
      if (result?.user) return { ...result, user: this.findUserById(result.user.id) };
      if (result?.id) {
        for (const field of ['users', 'questions', 'profiles', 'registrationSubmissions']) {
          const committed = this.state[field].find(item => item.id === result.id);
          if (committed) return committed;
        }
      }
      return result;
    });
  }

  persistUserUpdate(id, prepare, saveFailureMessage = '暂时无法确认保存成功，请稍后重试；若密码无法登录，请联系管理员') {
    return this.enqueueWrite(async () => {
      const user = this.findUserById(id);
      if (!user) throw new Error('未找到账号');
      const patch = await prepare(user);
      if (patch == null) return user;
      if (this.findUserById(id) !== user) throw new Error('账号已发生变化，请重新登录');
      const snapshot = JSON.parse(JSON.stringify(this.state));
      Object.assign(snapshot.users.find(item => item.id === id), patch);
      try {
        await this.persistSnapshot(snapshot);
      } catch (cause) {
        if (cause.code === 'backup_unconfirmed' || cause.code === 'state_conflict') throw cause;
        const error = new Error(saveFailureMessage, { cause });
        error.status = 503;
        throw error;
      }
      // Only publish credentials and invalidate sessions after durable success.
      Object.assign(user, patch);
      return user;
    });
  }

  findUserById(id) {
    return this.state.users.find(user => user.id === id) || null;
  }

  findUserByUsername(username) {
    const normalized = normalizeUsername(username);
    return this.state.users.find(user => user.username === normalized) || null;
  }

  findUserByDisplayName(displayName) {
    const normalized = cleanName(displayName).toLocaleLowerCase('zh-CN');
    return this.state.users.find(user => user.displayName.toLocaleLowerCase('zh-CN') === normalized) || null;
  }

  listUsers() {
    return this.state.users.map(user => ({
      ...publicUser(user),
      sessionActive: !!(user.activeSession && user.activeSession.expiresAt > this.now()),
    })).sort((a, b) => a.username.localeCompare(b.username));
  }

  listProfiles() {
    return this.state.profiles.map(profile => ({
      ...profile,
      experiences: Array.isArray(profile.experiences) ? profile.experiences.map(item => ({ ...item })) : [],
    }));
  }

  listRosterRecords() {
    return this.state.rosterRecords.map(record => ({
      ...record,
      experiences: Array.isArray(record.experiences) ? record.experiences.map(item => ({ ...item })) : [],
    }));
  }

  async replaceRosterRecords(records, meta = {}) {
    if (!this.mutationDraft) return this.commitMutation(draft => draft.replaceRosterRecords(records, meta));
    if (!Array.isArray(records) || !records.length) throw new Error('校友基线不能为空');
    const normalized = records.map((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('校友基线记录格式不正确');
      const item = JSON.parse(JSON.stringify(record));
      item.id = cleanName(item.id) || `a${String(index + 1).padStart(4, '0')}`;
      item.name = cleanName(item.name);
      if (!item.name) throw new Error(`第 ${index + 1} 条校友基线缺少姓名`);
      return item;
    });
    this.state.rosterRecords = normalized;
    this.state.rosterMeta = {
      count: normalized.length,
      contactCount: normalized.filter(record => cleanName(record.contact)).length,
      digest: cleanName(meta.digest),
      source: cleanName(meta.source),
      importedAt: new Date(this.now()).toISOString(),
    };
    await this.save();
    return { ...this.state.rosterMeta };
  }

  listRosterReview() {
    return {
      pending: this.state.rosterReview.pending.map(item => ({
        ...item,
        reasons: Array.isArray(item.reasons) ? [...item.reasons] : [],
      })),
    };
  }

  async replaceRosterReview(pending) {
    if (!this.mutationDraft) return this.commitMutation(draft => draft.replaceRosterReview(pending));
    if (!Array.isArray(pending)) throw new Error('待核对名单格式不正确');
    this.state.rosterReview = {
      pending: JSON.parse(JSON.stringify(pending)),
    };
    await this.save();
    return this.listRosterReview();
  }

  findProfileByUserId(userId) {
    return this.state.profiles.find(profile => profile.userId === userId) || null;
  }

  async recordProfileReminderLogin(userId) {
    let reminder = null;
    await this.persistUserUpdate(userId, user => {
      const change = profileReminderChange(user, this.now());
      reminder = change?.reminder || null;
      return change?.patch || null;
    });
    return reminder;
  }

  async claimSession(userId, tokenTtlMs, leaseMs, expectedPasswordHash = '', takeOverSessionId = '') {
    let profileReminder = null;
    const user = await this.persistUserUpdate(userId, current => {
      if (!current.active) throw new Error('账号不可用');
      if (expectedPasswordHash && current.passwordHash !== expectedPasswordHash) {
        const error = new Error('账号或密码不正确，请重新登录');
        error.status = 401;
        error.code = 'invalid_credentials';
        throw error;
      }
      const now = this.now();
      if (current.activeSession && current.activeSession.expiresAt > now
        && !(current.passwordChanged && takeOverSessionId === current.activeSession.id)) {
        const error = new Error('这个账号已在另一处登录。可在原设备退出；若原设备已关闭，请等待占用到期后重试。');
        error.status = 409;
        error.code = 'account_in_use';
        error.canTakeOver = !!current.passwordChanged;
        error.retryAfterSeconds = Math.ceil((current.activeSession.expiresAt - now) / 1000);
        if (error.canTakeOver) error.takeOverSessionId = current.activeSession.id;
        throw error;
      }
      const reminder = profileReminderChange(current, now);
      profileReminder = reminder?.reminder || null;
      const tokenExpiresAt = now + tokenTtlMs;
      return {
        ...(reminder?.patch || {}),
        activeSession: {
          id: crypto.randomBytes(24).toString('base64url'),
          expiresAt: Math.min(now + leaseMs, tokenExpiresAt),
          tokenExpiresAt,
        },
      };
    }, '登录状态暂时无法保存，请稍后重试');
    return { user, profileReminder };
  }

  async renewSession(userId, sessionId, leaseMs) {
    await this.persistUserUpdate(userId, user => {
      const session = user.activeSession;
      const now = this.now();
      if (!session || session.id !== sessionId || session.expiresAt <= now || session.tokenExpiresAt <= now) {
        const error = new Error('登录已失效，请重新登录');
        error.status = 401;
        error.code = 'session_expired';
        throw error;
      }
      const expiresAt = Math.min(now + leaseMs, session.tokenExpiresAt);
      if (session.expiresAt <= expiresAt && expiresAt - session.expiresAt < leaseMs / 2) return null;
      return { activeSession: { ...session, expiresAt } };
    }, '登录状态暂时无法续期，请稍后重试');
  }

  async releaseSession(userId, sessionId) {
    await this.persistUserUpdate(userId, user => (
      user.activeSession?.id === sessionId ? { activeSession: null } : null
    ), '退出登录暂时无法保存，请稍后重试');
  }

  async clearSession(userId) {
    await this.persistUserUpdate(userId, user => user.activeSession ? { activeSession: null } : null);
  }

  async updateOwnProfile(userId, input = {}, baseProfile = {}, sessionId = '') {
    return this.enqueueWrite(async () => {
      const user = this.findUserById(userId);
      if (!user) throw new Error('未找到账号');
      requireCurrentSession(user, sessionId, this.now());
      const snapshot = JSON.parse(JSON.stringify(this.state));
      let profile = snapshot.profiles.find(item => item.userId === user.id);
      const original = profile || { ...baseProfile, name: user.displayName };
      const cleaned = cleanEditableProfile(input, { ...original, name: user.displayName });
      const now = new Date(this.now()).toISOString();
      const month = shanghaiYearMonth(this.now());
      const experiences = Array.isArray(profile && profile.experiences)
        ? profile.experiences.map(item => ({ ...item }))
        : [];

      if (!profile || !Array.isArray(profile.experiences)) {
        const importedMonth = baseProfile.id
          ? (user.profileFirstFilledMonth || shanghaiYearMonth(this.now()))
          : (profile && profile.createdAt ? String(profile.createdAt).slice(0, 7) : '');
        const imported = experienceSnapshot(original, {
          recordedMonth: importedMonth,
          recordedAt: profile && profile.createdAt ? profile.createdAt : '',
        });
        if (imported) experiences.push(imported);
      }

      const current = [...experiences].reverse().find(item => item.isCurrent !== false) || null;
      if (!current || !sameExperience(current, cleaned)) {
        for (const item of experiences) item.isCurrent = false;
        const next = experienceSnapshot(cleaned, { recordedMonth: month, recordedAt: now });
        if (next) {
          if (experiences.length >= MAX_PROFILE_EXPERIENCES) {
            throw new Error(`经历记录已达到 ${MAX_PROFILE_EXPERIENCES} 条，请先删除一条过去经历再保存`);
          }
          experiences.push(next);
        }
      } else {
        for (const item of experiences) item.isCurrent = item.id === current.id;
      }

      if (!profile) {
        profile = {
          id: `n${crypto.randomUUID().replace(/-/g, '')}`,
          userId: user.id,
          baseRecordId: baseProfile.id || '',
          source: baseProfile.id ? 'self-update-imported' : 'self-update',
          reviewStatus: 'approved',
          createdAt: now,
        };
        snapshot.profiles.push(profile);
      }
      Object.assign(profile, cleaned, {
        name: user.displayName,
        experiences,
        updatedAt: now,
      });
      try {
        await this.persistSnapshot(snapshot);
      } catch (cause) {
        if (cause.code === 'backup_unconfirmed' || cause.code === 'state_conflict') throw cause;
        const error = new Error('资料暂时无法保存，请稍后重试', { cause });
        error.status = 503;
        throw error;
      }
      this.state.profiles = snapshot.profiles;
      return {
        ...profile,
        experiences: profile.experiences.map(item => ({ ...item })),
      };
    });
  }

  async deleteOwnExperience(userId, experienceId, sessionId = '') {
    return this.enqueueWrite(async () => {
      const user = this.findUserById(userId);
      if (!user) throw new Error('未找到账号');
      requireCurrentSession(user, sessionId, this.now());
      const snapshot = JSON.parse(JSON.stringify(this.state));
      const profile = snapshot.profiles.find(item => item.userId === userId);
      const item = profile?.experiences?.find(entry => entry.id === experienceId);
      if (!item) {
        const error = new Error('这段经历不存在或已被删除');
        error.status = 404;
        throw error;
      }
      if (item.isCurrent !== false) {
        const error = new Error('当前经历请在资料编辑区修改');
        error.status = 400;
        throw error;
      }
      profile.experiences = profile.experiences.filter(entry => entry.id !== experienceId);
      profile.updatedAt = new Date(this.now()).toISOString();
      try {
        await this.persistSnapshot(snapshot);
      } catch (cause) {
        if (cause.code === 'backup_unconfirmed' || cause.code === 'state_conflict') throw cause;
        const error = new Error('经历暂时无法删除，请稍后重试', { cause });
        error.status = 503;
        throw error;
      }
      this.state.profiles = snapshot.profiles;
      return profile;
    });
  }

  listProfilesForAdmin() {
    const fields = [
      'id', 'registrationId', 'userId', 'name', 'edu', 'cohort', 'status', 'industry', 'org', 'doing',
      'city', 'offer', 'want', 'hiring', 'message', 'willingContact', 'contact',
      'experiences', 'source', 'reviewStatus', 'reviewedAt', 'reviewedBy', 'createdAt', 'updatedAt',
    ];
    return this.state.profiles.map(profile => Object.fromEntries(
      fields.filter(field => Object.prototype.hasOwnProperty.call(profile, field))
        .map(field => [field, field === 'experiences' && Array.isArray(profile[field])
          ? profile[field].map(item => ({ ...item })) : profile[field]]),
    )).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  listRegistrationSubmissionsForAdmin(filters = {}) {
    const status = cleanName(filters.status);
    const query = cleanName(filters.query).toLocaleLowerCase('zh-CN');
    return this.state.registrationSubmissions
      .filter(item => !status || item.status === status)
      .filter(item => {
        if (!query) return true;
        const profile = item.profile || {};
        return [item.id, item.ip, item.status, profile.name, profile.cohort, profile.city, profile.industry]
          .some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
      })
      .map(item => ({
        id: item.id,
        status: item.status,
        ip: item.ip,
        attemptsUsed: item.attemptsUsed || 0,
        quizPassed: !!item.quizPassed,
        quizPassedAt: item.quizPassedAt || '',
        userId: item.userId || '',
        username: item.username || '',
        reviewerNote: item.reviewerNote || '',
        reviewedAt: item.reviewedAt || '',
        reviewedBy: item.reviewedBy || '',
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        profile: { ...(item.profile || {}) },
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  findRegistrationSubmission(id) {
    return this.state.registrationSubmissions.find(item => item.id === id) || null;
  }

  async updateRegistrationSubmissionStatus(id, status, reviewer = {}, note = '') {
    if (!this.mutationDraft) return this.commitMutation(draft => draft.updateRegistrationSubmissionStatus(id, status, reviewer, note));
    const submission = this.findRegistrationSubmission(id);
    if (!submission) throw new Error('未找到注册资料');
    if (!['pending', 'rejected'].includes(status)) throw new Error('不支持的资料状态');
    submission.status = status;
    submission.reviewerNote = limitedText(note, '审核备注', 500);
    submission.reviewedAt = new Date(this.now()).toISOString();
    submission.reviewedBy = cleanName(reviewer.username || reviewer.displayName);
    submission.updatedAt = submission.reviewedAt;
    await this.save();
    return submission;
  }

  async approveRegistration(id, reviewer = {}, note = '') {
    if (!this.mutationDraft) return this.commitMutation(draft => draft.approveRegistration(id, reviewer, note));
    const submission = this.findRegistrationSubmission(id);
    if (!submission) throw new Error('未找到注册资料');
    if (submission.status === 'approved') {
      return this.findUserById(submission.userId);
    }
    if (submission.status === 'rejected') throw new Error('已拒绝的资料不能直接通过，请先恢复为待处理');
    const profile = submission.profile || {};
    const username = usernameFromName(profile.name);
    if (!username) throw new Error('无法从姓名生成账号，请手动指定账号');
    if (this.findUserByDisplayName(profile.name)) throw new Error('该姓名已经有账号，请到账号管理查看');
    if (this.findUserByUsername(username)) {
      const error = new Error('姓名拼音与现有账号冲突，请先在账号管理中处理');
      error.code = 'username_conflict';
      throw error;
    }
    const user = await this.createUser({
      displayName: profile.name,
      cohort: profile.cohort,
      username,
      password: username,
      role: 'user',
      allowSuffix: false,
      source: 'admin-approved-registration',
    });
    const now = new Date(this.now()).toISOString();
    const existingProfile = this.state.profiles.find(item => item.registrationId === submission.id);
    const savedProfile = {
      ...profile,
      id: existingProfile ? existingProfile.id : `n${crypto.randomUUID().replace(/-/g, '')}`,
      registrationId: submission.id,
      userId: user.id,
      source: 'quiz-registration',
      reviewStatus: 'approved',
      reviewedAt: now,
      reviewedBy: cleanName(reviewer.username || reviewer.displayName),
      updatedAt: now,
    };
    if (existingProfile) Object.assign(existingProfile, savedProfile);
    else this.state.profiles.push({ ...savedProfile, createdAt: now });
    submission.status = 'approved';
    submission.userId = user.id;
    submission.username = user.username;
    submission.reviewerNote = limitedText(note, '审核备注', 500);
    submission.reviewedAt = now;
    submission.reviewedBy = cleanName(reviewer.username || reviewer.displayName);
    submission.updatedAt = now;
    await this.save();
    return user;
  }

  async authenticate(username, password) {
    const user = this.findUserByUsername(username);
    if (!user || !user.active) return null;
    const passwordHash = user.passwordHash;
    if (!(await verifyPassword(password, passwordHash))) return null;
    return user.active && user.passwordHash === passwordHash ? user : null;
  }

  nextUsername(base) {
    const normalized = normalizeUsername(base);
    if (!normalized) return '';
    if (!this.findUserByUsername(normalized)) return normalized;
    let suffix = 2;
    while (this.findUserByUsername(normalized + suffix)) suffix += 1;
    return normalized + suffix;
  }

  async createUser(input = {}) {
    if (!this.mutationDraft) return this.commitMutation(draft => draft.createUser(input));
    const displayName = cleanName(input.displayName);
    if (!displayName) throw new Error('姓名不能为空');
    const base = normalizeUsername(input.username) || usernameFromName(displayName);
    const username = input.allowSuffix === false ? base : this.nextUsername(base);
    if (!username) throw new Error('无法从姓名生成账号，请联系管理员处理');
    if (input.allowSuffix === false && this.findUserByUsername(username)) throw new Error('账号已存在');
    const password = String(input.password == null ? username : input.password);
    const now = new Date(this.now()).toISOString();
    const user = {
      id: crypto.randomUUID(),
      username,
      displayName,
      cohort: cleanName(input.cohort),
      role: input.role === 'admin' ? 'admin' : 'user',
      active: input.active !== false,
      passwordHash: await hashPassword(password, this.scryptCost),
      passwordChanged: password !== username,
      tokenVersion: 1,
      source: input.source || 'admin',
      profileFirstFilledMonth: shanghaiYearMonth(this.now()),
      createdAt: now,
      updatedAt: now,
    };
    this.state.users.push(user);
    await this.save();
    return user;
  }

  async ensureAdmin(input = {}) {
    const username = normalizeUsername(input.username || 'admin');
    const existing = this.findUserByUsername(username);
    if (existing) {
      if (existing.role !== 'admin') throw new Error(`账号 ${username} 已被普通用户占用，无法作为管理员`);
      return existing;
    }
    return this.createUser({
      displayName: cleanName(input.displayName) || '管理员',
      username,
      password: input.password,
      role: 'admin',
      allowSuffix: false,
      source: 'bootstrap-admin',
    });
  }

  async changePassword(userId, oldPassword, newPassword, sessionId = '') {
    return this.persistUserUpdate(userId, async user => {
      if (!user.active) throw new Error('账号不可用');
      requireCurrentSession(user, sessionId, this.now());
      validatePassword(newPassword, user.username);
      if (!(await verifyPassword(oldPassword, user.passwordHash))) throw new Error('当前密码不正确');
      return {
        passwordHash: await hashPassword(newPassword, this.scryptCost),
        passwordChanged: true,
        tokenVersion: user.tokenVersion + 1,
        updatedAt: new Date(this.now()).toISOString(),
      };
    });
  }

  async updateUser(id, patch = {}) {
    return this.persistUserUpdate(id, async user => {
      const changes = { tokenVersion: user.tokenVersion + 1, activeSession: null, updatedAt: new Date(this.now()).toISOString() };
      if (typeof patch.active === 'boolean') changes.active = patch.active;
      if (patch.displayName != null) {
        const displayName = cleanName(patch.displayName);
        if (!displayName) throw new Error('姓名不能为空');
        changes.displayName = displayName;
      }
      if (patch.cohort != null) changes.cohort = cleanName(patch.cohort);
      if (patch.resetPassword) {
        changes.passwordHash = await hashPassword(user.username, this.scryptCost);
        changes.passwordChanged = false;
      }
      return changes;
    });
  }

  async deleteUser(id) {
    if (!this.mutationDraft) return this.commitMutation(draft => draft.deleteUser(id));
    const user = this.findUserById(id);
    if (!user) {
      const error = new Error('未找到账号');
      error.code = 'user_not_found';
      throw error;
    }
    if (user.role === 'admin') {
      const error = new Error('管理员账号不能删除');
      error.code = 'cannot_delete_admin';
      throw error;
    }

    this.state.users = this.state.users.filter(item => item.id !== user.id);
    this.state.profiles = this.state.profiles.filter(profile => profile.userId !== user.id);
    this.state.registrationSubmissions = this.state.registrationSubmissions.filter(submission => (
      submission.userId !== user.id && submission.username !== user.username
    ));
    await this.save();
    return user;
  }

  listQuestions(includeAnswers = false) {
    return this.state.questions.map(question => includeAnswers ? { ...question, options: [...question.options] } : publicQuestion(question));
  }

  activeQuestions() {
    return this.state.questions.filter(question => question.active);
  }

  validateQuestion(input) {
    const prompt = cleanName(input.prompt);
    const options = Array.isArray(input.options) ? input.options.map(cleanName).filter(Boolean) : [];
    const correctIndex = Number(input.correctIndex);
    if (!prompt) throw new Error('题干不能为空');
    if (options.length < 2 || options.length > 6) throw new Error('每题需要 2 到 6 个选项');
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
      throw new Error('请选择正确答案');
    }
    return { prompt, options, correctIndex };
  }

  async createQuestion(input) {
    if (!this.mutationDraft) return this.commitMutation(draft => draft.createQuestion(input));
    const valid = this.validateQuestion(input || {});
    const now = new Date(this.now()).toISOString();
    const question = {
      id: crypto.randomUUID(),
      ...valid,
      active: input.active === true,
      notes: cleanName(input.notes),
      createdAt: now,
      updatedAt: now,
    };
    this.state.questions.push(question);
    await this.save();
    return question;
  }

  async updateQuestion(id, input) {
    if (!this.mutationDraft) return this.commitMutation(draft => draft.updateQuestion(id, input));
    const question = this.state.questions.find(item => item.id === id);
    if (!question) throw new Error('未找到题目');
    const valid = this.validateQuestion({
      prompt: input.prompt == null ? question.prompt : input.prompt,
      options: input.options == null ? question.options : input.options,
      correctIndex: input.correctIndex == null ? question.correctIndex : input.correctIndex,
    });
    Object.assign(question, valid);
    if (typeof input.active === 'boolean') question.active = input.active;
    if (input.notes != null) question.notes = cleanName(input.notes);
    question.updatedAt = new Date(this.now()).toISOString();
    await this.save();
    return question;
  }

  lockExpiry(lock) {
    if (lock.expiresAt) return Date.parse(lock.expiresAt);
    const lockedAt = Date.parse(lock.lockedAt || '');
    return Number.isFinite(lockedAt) ? lockedAt + REGISTRATION_LOCK_TTL_MS : 0;
  }

  purgeExpiredRegistrationLocks() {
    const now = this.now();
    const activeLocks = this.state.registrationLocks.filter(lock => this.lockExpiry(lock) > now);
    if (activeLocks.length === this.state.registrationLocks.length) return false;
    const expiredKeys = new Set(this.state.registrationLocks
      .filter(lock => this.lockExpiry(lock) <= now)
      .map(lock => lock.attemptKey || lock.ip));
    this.state.registrationLocks = activeLocks;
    for (const key of expiredKeys) delete this.state.registrationAttempts[key];
    return true;
  }

  purgeExpiredRegistrationSubmissions() {
    const cutoff = this.now() - this.pendingRegistrationTtlMs;
    const before = this.state.registrationSubmissions.length;
    this.state.registrationSubmissions = this.state.registrationSubmissions.filter(submission => {
      if (!['pending', 'locked'].includes(submission.status) || submission.userId || submission.reviewedBy) return true;
      const timestamp = Date.parse(submission.updatedAt || submission.createdAt || '');
      return !Number.isFinite(timestamp) || timestamp >= cutoff;
    });
    return before !== this.state.registrationSubmissions.length;
  }

  registrationInfo(ip, name) {
    this.purgeExpiredRegistrationLocks();
    const attemptKey = registrationAttemptKey(name);
    const legacyAttempt = this.state.registrationAttempts[ip];
    const sameLegacyName = legacyAttempt
      && cleanName(legacyAttempt.lastName).toLocaleLowerCase('zh-CN')
        === cleanName(name).toLocaleLowerCase('zh-CN');
    const attempt = this.state.registrationAttempts[attemptKey]
      || (sameLegacyName && legacyAttempt)
      || { count: 0, lastQuestionIds: [] };
    const lock = this.state.registrationLocks.find(item => (
      item.attemptKey === attemptKey
      || (!item.attemptKey && item.ip === ip
        && cleanName(item.lastName).toLocaleLowerCase('zh-CN')
          === cleanName(name).toLocaleLowerCase('zh-CN'))
    )) || null;
    return { attemptKey, attempt, lock };
  }

  cleanupQuizSessions() {
    const now = this.now();
    for (const [attemptId, session] of this.quizSessions.entries()) {
      if (session.expiresAt <= now) this.quizSessions.delete(attemptId);
    }
    for (const [ip, attemptId] of this.activeQuizByIp.entries()) {
      if (!this.quizSessions.has(attemptId)) this.activeQuizByIp.delete(ip);
    }
  }

  invalidateQuizSessionsForKey(attemptKey) {
    for (const [attemptId, session] of this.quizSessions.entries()) {
      if (session.attemptKey === attemptKey) this.quizSessions.delete(attemptId);
    }
    this.activeQuizByIp.delete(attemptKey);
  }

  async beginRegistration(input = {}) {
    if (!this.mutationDraft) return this.commitMutation(draft => draft.beginRegistration(input));
    this.cleanupQuizSessions();
    this.purgeExpiredRegistrationSubmissions();
    const ip = String(input.ip || 'unknown');
    const profile = cleanProfile(input.profile || input);
    if (this.findUserByDisplayName(profile.name)) {
      const error = new Error('该姓名已经有账号，请直接登录或联系管理员核对');
      error.code = 'account_exists';
      throw error;
    }
    const { attemptKey, attempt, lock } = this.registrationInfo(ip, profile.name);
    if (lock) {
      const error = new Error('该姓名的自助注册已锁定 1 小时，请稍后再试或联系管理员');
      error.code = 'registration_locked';
      throw error;
    }
    const activeAttemptId = this.activeQuizByIp.get(attemptKey);
    if (activeAttemptId && this.quizSessions.has(activeAttemptId)) {
      const error = new Error('已有一轮答题进行中，请完成当前题目后再试');
      error.code = 'registration_in_progress';
      throw error;
    }
    if (this.quizSessions.size >= MAX_QUIZ_SESSIONS) {
      const error = new Error('当前注册人数较多，请稍后再试');
      error.code = 'registration_busy';
      throw error;
    }
    const active = this.activeQuestions();
    if (active.length < 3) {
      const error = new Error('题库维护中，请联系管理员');
      error.code = 'question_bank_unavailable';
      throw error;
    }
    const lastQuestionIds = Array.isArray(attempt.lastQuestionIds) ? attempt.lastQuestionIds : [];
    let candidates = active.filter(question => !lastQuestionIds.includes(question.id));
    if (candidates.length < 3) candidates = active;
    const attemptId = crypto.randomBytes(24).toString('base64url');
    const selected = shuffle(candidates, this.randomInt).slice(0, 3);
    const now = new Date(this.now()).toISOString();
    const reusableSubmission = [...this.state.registrationSubmissions].reverse().find(item => (
      ['pending', 'locked'].includes(item.status)
      && cleanName(item.profile && item.profile.name).toLocaleLowerCase('zh-CN')
        === cleanName(profile.name).toLocaleLowerCase('zh-CN')
      && !item.userId
    ));
    const unfinishedCount = this.state.registrationSubmissions.filter(item => (
      ['pending', 'locked'].includes(item.status) && !item.userId
    )).length;
    if (!reusableSubmission && unfinishedCount >= this.maxPendingRegistrationSubmissions) {
      const error = new Error('当前待处理注册较多，请稍后再试或联系管理员');
      error.code = 'registration_busy';
      throw error;
    }
    const submissionId = reusableSubmission
      ? reusableSubmission.id
      : `r${crypto.randomUUID().replace(/-/g, '')}`;
    if (reusableSubmission) {
      Object.assign(reusableSubmission, {
        status: 'pending',
        ip,
        attemptsUsed: attempt.count,
        profile: { ...profile },
        updatedAt: now,
      });
    } else {
      this.state.registrationSubmissions.push({
        id: submissionId,
        status: 'pending',
        ip,
        attemptsUsed: attempt.count,
        profile: { ...profile },
        createdAt: now,
        updatedAt: now,
      });
    }
    this.quizSessions.set(attemptId, {
      ip,
      attemptKey,
      profile,
      submissionId,
      questions: selected.map(question => ({ id: question.id, correctIndex: question.correctIndex })),
      expiresAt: this.now() + QUIZ_TTL_MS,
    });
    this.activeQuizByIp.set(attemptKey, attemptId);
    return {
      attemptId,
      attemptsUsed: attempt.count,
      attemptsRemaining: MAX_REGISTRATION_FAILURES - attempt.count,
      questions: selected.map(publicQuestion),
    };
  }

  async submitRegistration(input = {}) {
    if (!this.mutationDraft) return this.commitMutation(draft => draft.submitRegistration(input));
    this.cleanupQuizSessions();
    const attemptId = String(input.attemptId || '');
    const session = this.quizSessions.get(attemptId);
    this.quizSessions.delete(attemptId);
    if (!session || session.expiresAt < this.now()) throw new Error('本轮答题已过期，请重新获取题目');
    const ip = String(input.ip || 'unknown');
    if (session.ip !== ip) throw new Error('答题网络发生变化，请重新获取题目');
    const attemptKey = session.attemptKey || registrationAttemptKey(session.profile.name);
    if (this.activeQuizByIp.get(attemptKey) === attemptId) this.activeQuizByIp.delete(attemptKey);
    const submission = this.findRegistrationSubmission(session.submissionId);
    if (!submission || ['approved', 'rejected'].includes(submission.status)) {
      throw new Error('这份注册资料已结束处理，请重新填写');
    }
    const current = this.registrationInfo(ip, session.profile.name);
    if (current.lock || current.attempt.count >= MAX_REGISTRATION_FAILURES) {
      return {
        passed: false,
        locked: true,
        attemptsUsed: Math.max(MAX_REGISTRATION_FAILURES, current.attempt.count || 0),
        attemptsRemaining: 0,
      };
    }
    const answers = input.answers && typeof input.answers === 'object' ? input.answers : {};
    const passed = session.questions.every(question => (
      Object.hasOwn(answers, question.id)
      && Number.isInteger(answers[question.id])
      && answers[question.id] === question.correctIndex
    ));
    if (passed) {
      if (this.findUserByDisplayName(session.profile.name)) throw new Error('该姓名已经有账号，请联系管理员核对');
      const username = usernameFromName(session.profile.name);
      if (!username) throw new Error('无法从姓名生成账号，请联系管理员处理');
      if (this.findUserByUsername(username)) {
        const error = new Error('姓名拼音与现有账号冲突，请联系管理员人工处理');
        error.code = 'username_conflict';
        throw error;
      }
      delete this.state.registrationAttempts[attemptKey];
      if (this.state.registrationAttempts[ip] === current.attempt) delete this.state.registrationAttempts[ip];
      this.invalidateQuizSessionsForKey(attemptKey);
      const now = new Date(this.now()).toISOString();
      const user = {
        id: crypto.randomUUID(),
        username,
        displayName: session.profile.name,
        cohort: session.profile.cohort,
        role: 'user',
        active: true,
        passwordHash: await hashPassword(username, this.scryptCost),
        passwordChanged: false,
        tokenVersion: 1,
        source: 'quiz-registration',
        profileFirstFilledMonth: shanghaiYearMonth(this.now()),
        createdAt: now,
        updatedAt: now,
      };
      this.state.users.push(user);
      const initialExperience = experienceSnapshot(session.profile, {
        recordedMonth: shanghaiYearMonth(this.now()),
        recordedAt: now,
      });
      this.state.profiles.push({
        ...session.profile,
        id: `n${crypto.randomUUID().replace(/-/g, '')}`,
        registrationId: session.submissionId,
        userId: user.id,
        source: 'quiz-registration',
        reviewStatus: 'approved',
        reviewedAt: now,
        reviewedBy: '自动答题验证',
        experiences: initialExperience ? [initialExperience] : [],
        createdAt: now,
        updatedAt: now,
      });
      submission.status = 'approved';
      submission.userId = user.id;
      submission.username = user.username;
      submission.attemptsUsed = current.attempt.count;
      submission.quizPassed = true;
      submission.quizPassedAt = now;
      submission.reviewedAt = now;
      submission.reviewedBy = '自动答题验证';
      submission.updatedAt = now;
      await this.save();
      return { passed: true, user };
    }

    const previous = current.attempt;
    const count = previous.count + 1;
    if (this.state.registrationAttempts[ip] === previous) delete this.state.registrationAttempts[ip];
    this.state.registrationAttempts[attemptKey] = {
      ip,
      count,
      lastQuestionIds: session.questions.map(question => question.id),
      lastName: session.profile.name,
      updatedAt: new Date(this.now()).toISOString(),
    };
    let locked = false;
    if (count >= MAX_REGISTRATION_FAILURES) {
      locked = true;
      this.state.registrationLocks.push({
        id: crypto.randomUUID(),
        ip,
        attemptKey,
        lastName: session.profile.name,
        attempts: count,
        lockedAt: new Date(this.now()).toISOString(),
        expiresAt: new Date(this.now() + REGISTRATION_LOCK_TTL_MS).toISOString(),
      });
      this.invalidateQuizSessionsForKey(attemptKey);
    }
    submission.status = locked ? 'locked' : 'pending';
    submission.attemptsUsed = count;
    submission.updatedAt = new Date(this.now()).toISOString();
    if (locked) submission.reviewerNote = '答题失败达到 5 次，该姓名的自助注册暂时锁定';
    await this.save();
    return {
      passed: false,
      locked,
      attemptsUsed: count,
      attemptsRemaining: Math.max(0, MAX_REGISTRATION_FAILURES - count),
    };
  }

  listRegistrationActivity() {
    const activeLocks = this.state.registrationLocks.filter(lock => this.lockExpiry(lock) > this.now());
    const attemptKeys = new Set([
      ...Object.keys(this.state.registrationAttempts),
      ...activeLocks.map(item => item.attemptKey || item.ip),
    ]);
    return [...attemptKeys].map(attemptKey => {
      const attempt = this.state.registrationAttempts[attemptKey] || {};
      const lock = activeLocks.find(item => (item.attemptKey || item.ip) === attemptKey);
      return {
        ip: attempt.ip || (lock && lock.ip) || '',
        attempts: attempt.count || (lock && lock.attempts) || 0,
        lastName: attempt.lastName || (lock && lock.lastName) || '',
        updatedAt: attempt.updatedAt || (lock && lock.lockedAt) || '',
        locked: !!lock,
        lockId: lock ? lock.id : '',
        expiresAt: lock ? new Date(this.lockExpiry(lock)).toISOString() : '',
      };
    }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async unlockRegistration(lockId) {
    if (!this.mutationDraft) return this.commitMutation(draft => draft.unlockRegistration(lockId));
    this.purgeExpiredRegistrationLocks();
    const lock = this.state.registrationLocks.find(item => item.id === lockId);
    if (!lock) throw new Error('未找到锁定记录');
    this.state.registrationLocks = this.state.registrationLocks.filter(item => item.id !== lockId);
    delete this.state.registrationAttempts[lock.attemptKey || lock.ip];
    await this.save();
  }
}

class LoginLimiter {
  constructor(options = {}) {
    this.maxFailures = options.maxFailures || 5;
    this.windowMs = options.windowMs || 15 * 60 * 1000;
    this.blockMs = options.blockMs || 15 * 60 * 1000;
    this.now = options.now || (() => Date.now());
    this.maxEntries = options.maxEntries || MAX_LOGIN_LIMITER_ENTRIES;
    this.cleanupIntervalMs = options.cleanupIntervalMs || 60 * 1000;
    this.lastCleanupAt = -Infinity;
    this.entries = new Map();
  }

  key(ip, username) {
    return `${String(ip).slice(0, 128)}|${normalizeUsername(username).slice(0, 128)}`;
  }

  maybeCleanup() {
    const now = this.now();
    if (now - this.lastCleanupAt < this.cleanupIntervalMs) return;
    this.lastCleanupAt = now;
    for (const [key, entry] of this.entries.entries()) {
      if ((!entry.blockedUntil || entry.blockedUntil <= now) && now - entry.startedAt > this.windowMs) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  check(ip, username) {
    this.maybeCleanup();
    const key = this.key(ip, username);
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true };
    if (entry.blockedUntil && entry.blockedUntil > this.now()) {
      return { allowed: false, retryAfterMs: entry.blockedUntil - this.now() };
    }
    if (this.now() - entry.startedAt > this.windowMs) this.entries.delete(key);
    return { allowed: true };
  }

  fail(ip, username) {
    this.maybeCleanup();
    const key = this.key(ip, username);
    const current = this.entries.get(key);
    const entry = !current || this.now() - current.startedAt > this.windowMs
      ? { failures: 0, startedAt: this.now(), blockedUntil: 0 }
      : current;
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) entry.blockedUntil = this.now() + this.blockMs;
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === key && this.entries.size === 1) break;
      this.entries.delete(oldest);
    }
    return entry;
  }

  clear(ip, username) {
    this.entries.delete(this.key(ip, username));
  }
}

module.exports = {
  AuthStore,
  LoginLimiter,
  MAX_REGISTRATION_FAILURES,
  MAX_PENDING_REGISTRATION_SUBMISSIONS,
  MAX_QUIZ_SESSIONS,
  MAX_PROFILE_EXPERIENCES,
  PENDING_REGISTRATION_TTL_MS,
  REGISTRATION_LOCK_TTL_MS,
  cleanProfile,
  cleanName,
  hashPassword,
  normalizeUsername,
  publicQuestion,
  publicUser,
  usernameFromName,
  validatePassword,
  verifyPassword,
};
