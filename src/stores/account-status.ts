import { create } from "zustand";
import * as api from "@/lib/api";
import { variantUsesIntlCodebuddyIde } from "@/lib/variant";
import type {
  CheckinConfig,
  CodeBuddyCliStatus,
  CodeBuddyCnIdeStatus,
  RateLimitEntry,
  TravelConfig,
  TravelStatus,
  VscodeExtStatus,
  WbVariant,
} from "@/lib/types";

/**
 * 账号页「派生状态」缓存。
 *
 * 这些状态此前都是 `AccountsPage` 的组件内 state：react-router 切 Tab 会卸载组件，
 * 切回来全部重新请求，卡片上的签到 / 旅行 / 限额标签会先空一下再填上。搬到 store 后
 * 组件重新挂载直接命中缓存，只有超过有效期或显式失效时才真正发请求。
 *
 * 每类状态都是三件套：数据 map + 时间戳（判定是否过期）+ 模块级 inflight（并发去重，
 * 快速来回切 Tab 不会重复发同一批请求）。
 */

/** 今日是否已签到：一天才变一次，5 分钟足够及时；跨天另有 dateKey 兜底。 */
const CHECKIN_TTL_MS = 5 * 60 * 1000;
/** 旅行：后台派发/领取循环最快 15 分钟变一次，30 秒用于及时反映"到期领取"。 */
const TRAVEL_TTL_MS = 30 * 1000;
/** 限额台账：后端日志扫描按 5 分钟节流，前端同频。 */
const RATE_LIMIT_TTL_MS = 5 * 60 * 1000;
/** 目标应用（CLI / IDE / VS Code）状态：本地探测，15 秒够挡住切 Tab 的重拉。 */
const APP_STATUS_TTL_MS = 15 * 1000;
/** 钥匙串 / VS Code 数据库探测开销较大，间隔更长。 */
const DETECT_TTL_MS = 60 * 1000;
/** 自动签到 / 自动旅行 / 限额监听开关配置。 */
const CONFIG_TTL_MS = 60 * 1000;

const checkinInflight = new Set<string>();
const travelInflight = new Set<string>();
let rateLimitsInflight: Promise<void> | undefined;
let rateLimitConfigInflight: Promise<void> | undefined;
/** 在途的应用状态刷新按档位区分：切档位要读的是另一套应用，不能复用上一档位的结果。 */
let appStatusInflight: { variant: WbVariant; promise: Promise<void> } | undefined;

/** 本地日期键：跨过零点后"今日已签到"必须整体作废。 */
function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function uniqueIds(accountIds: string[]): string[] {
  return [...new Set(accountIds.filter(Boolean))];
}

interface AccountStatusState {
  /** 账号 id -> 今日是否已签到（undefined=未知） */
  checkinMap: Record<string, boolean>;
  /** 账号 id -> 最近一次查询完成时刻（成功/失败都记，失败不再每次挂载重试） */
  checkinAtMap: Record<string, number>;
  checkinDateKey: string;

  /** 账号 id -> 今日旅行状态（undefined=未知） */
  travelMap: Record<string, TravelStatus>;
  travelAtMap: Record<string, number>;

  /** 账号 id -> 当前受限的模型（后端限额台账：hook 信号 + 日志扫描） */
  rateLimitMap: Record<string, RateLimitEntry[]>;
  rateLimitAt: number;
  /** 「限额监听」开关；null=配置尚未读到，不得按默认 true 先扫一轮。 */
  rateLimitEnabled: boolean | null;
  rateLimitConfigAt: number;

  autoCheckinConfig: CheckinConfig | null;
  autoCheckinConfigAt: number;
  autoTravelConfig: TravelConfig | null;
  autoTravelConfigAt: number;

  codebuddyCli: CodeBuddyCliStatus | null;
  codebuddyCliAt: number;
  codebuddyCnIde: CodeBuddyCnIdeStatus | null;
  codebuddyCnIdeAt: number;
  vscodeExt: VscodeExtStatus | null;
  vscodeExtAt: number;
  detectAt: number;

  /** 只给过期/未缓存的账号拉签到；`force` 忽略有效期。 */
  ensureCheckin: (accountIds: string[], opts?: { force?: boolean }) => Promise<void>;
  ensureTravel: (accountIds: string[], opts?: { force?: boolean }) => Promise<void>;
  /** 限额台账（一次返回全部账号）；未开启监听或 5 分钟内扫过则跳过。 */
  ensureRateLimits: (opts?: { force?: boolean }) => Promise<void>;
  ensureRateLimitConfig: (opts?: { force?: boolean }) => Promise<void>;
  /** 返回错误文案（null 表示成功或命中缓存），供调用方 toast。 */
  ensureAutoCheckinConfig: (opts?: { force?: boolean }) => Promise<string | null>;
  ensureAutoTravelConfig: (opts?: { force?: boolean }) => Promise<string | null>;
  ensureAppStatus: (variant: WbVariant, opts?: { force?: boolean }) => Promise<void>;

  setAutoCheckinConfig: (config: CheckinConfig) => void;
  setAutoTravelConfig: (config: TravelConfig) => void;
  /** 账号被删除：清掉它的缓存条目，避免 map 无限增长。 */
  forgetAccount: (accountId: string) => void;
  /** 失效签到缓存（不传 ids 则全部失效）；保留旧值以免卡片闪空。 */
  invalidateCheckin: (accountIds?: string[]) => void;
  /** 手动签到已完成状态核验时直接写入「今天已签到」，不必再走展示查询。 */
  markCheckedIn: (accountIds: string[]) => void;
  invalidateTravel: (accountIds?: string[]) => void;
  invalidateRateLimits: () => void;
  /** 设置页改完配置（限额开关 / 自动签到 / 自动旅行）后调用。 */
  invalidateConfig: () => void;
}

export const useAccountStatusStore = create<AccountStatusState>((set, get) => ({
  checkinMap: {},
  checkinAtMap: {},
  checkinDateKey: todayKey(),
  travelMap: {},
  travelAtMap: {},
  rateLimitMap: {},
  rateLimitAt: 0,
  rateLimitEnabled: null,
  rateLimitConfigAt: 0,
  autoCheckinConfig: null,
  autoCheckinConfigAt: 0,
  autoTravelConfig: null,
  autoTravelConfigAt: 0,
  codebuddyCli: null,
  codebuddyCliAt: 0,
  codebuddyCnIde: null,
  codebuddyCnIdeAt: 0,
  vscodeExt: null,
  vscodeExtAt: 0,
  detectAt: 0,

  async ensureCheckin(accountIds, opts) {
    const ids = uniqueIds(accountIds);
    if (ids.length === 0) return;
    // 强制刷新必须先丢掉 webui 的批量缓存，否则会拿到刷新前的旧值
    if (opts?.force) api.invalidateCheckinBatch();
    const key = todayKey();
    if (get().checkinDateKey !== key) {
      // 跨过本地零点：昨天的「已签到」不再有效，整体作废
      set({ checkinDateKey: key, checkinMap: {}, checkinAtMap: {} });
      api.invalidateCheckinBatch();
    }
    const now = Date.now();
    const state = get();
    const toFetch = ids.filter((id) => {
      if (checkinInflight.has(id)) return false;
      if (opts?.force) return true;
      const at = state.checkinAtMap[id];
      return at === undefined || now - at > CHECKIN_TTL_MS;
    });
    if (toFetch.length === 0) return;

    for (const id of toFetch) checkinInflight.add(id);
    await Promise.all(
      toFetch.map(async (id) => {
        try {
          const res = await api.getCheckinStatus(id);
          if (res.ok) {
            set((s) => ({
              checkinMap: { ...s.checkinMap, [id]: res.todayCheckedIn === true },
              checkinAtMap: { ...s.checkinAtMap, [id]: Date.now() },
            }));
            return;
          }
        } catch {
          /* 查询失败：保留原值 */
        }
        // 失败也记时刻，避免坏账号每次挂载都重发一轮
        set((s) => ({ checkinAtMap: { ...s.checkinAtMap, [id]: Date.now() } }));
      }),
    );
    for (const id of toFetch) checkinInflight.delete(id);
  },

  async ensureTravel(accountIds, opts) {
    const ids = uniqueIds(accountIds);
    if (ids.length === 0) return;
    // 同签到：强制刷新前先丢掉 webui 的批量缓存
    if (opts?.force) api.invalidateTravelBatch();
    const now = Date.now();
    const state = get();
    const toFetch = ids.filter((id) => {
      if (travelInflight.has(id)) return false;
      if (opts?.force) return true;
      const at = state.travelAtMap[id];
      return at === undefined || now - at > TRAVEL_TTL_MS;
    });
    if (toFetch.length === 0) return;

    for (const id of toFetch) travelInflight.add(id);
    await Promise.all(
      toFetch.map(async (id) => {
        try {
          const res = await api.getTravelStatus(id);
          set((s) => ({
            travelMap: { ...s.travelMap, [id]: res },
            travelAtMap: { ...s.travelAtMap, [id]: Date.now() },
          }));
        } catch {
          set((s) => ({ travelAtMap: { ...s.travelAtMap, [id]: Date.now() } }));
        }
      }),
    );
    for (const id of toFetch) travelInflight.delete(id);
  },

  async ensureRateLimits(opts) {
    // 开关未读到之前不扫：关闭监听后进账号页会误发请求/闪 chip
    if (get().rateLimitEnabled !== true) return;
    if (rateLimitsInflight) return rateLimitsInflight;
    const now = Date.now();
    if (!opts?.force && get().rateLimitAt > 0 && now - get().rateLimitAt < RATE_LIMIT_TTL_MS) return;

    const promise = (async () => {
      try {
        const payload = await api.getRateLimits();
        const next: Record<string, RateLimitEntry[]> = {};
        for (const entry of payload.accounts ?? []) {
          if (entry.limited?.length) next[entry.accountId] = entry.limited;
        }
        set({ rateLimitMap: next, rateLimitAt: Date.now() });
      } catch {
        // 老版本后端没有该命令、或扫描失败：按「无受限模型」处理，不影响其它功能
        set({ rateLimitMap: {}, rateLimitAt: Date.now() });
      } finally {
        rateLimitsInflight = undefined;
      }
    })();
    rateLimitsInflight = promise;
    return promise;
  },

  async ensureRateLimitConfig(opts) {
    if (rateLimitConfigInflight) return rateLimitConfigInflight;
    const now = Date.now();
    if (
      !opts?.force &&
      get().rateLimitConfigAt > 0 &&
      now - get().rateLimitConfigAt < CONFIG_TTL_MS
    ) {
      return;
    }
    const promise = (async () => {
      try {
        const config = await api.getRateLimitConfig();
        set({ rateLimitEnabled: config.enabled, rateLimitConfigAt: Date.now() });
      } catch {
        // 旧版本后端没有该命令：按默认开启
        set({ rateLimitEnabled: true, rateLimitConfigAt: Date.now() });
      } finally {
        rateLimitConfigInflight = undefined;
      }
      // 配置刚读到（或刚失效重读）时补一轮台账：挂载时开关还是 null，那一轮被跳过了
      if (get().rateLimitEnabled === true) void get().ensureRateLimits();
    })();
    rateLimitConfigInflight = promise;
    return promise;
  },

  async ensureAutoCheckinConfig(opts) {
    const state = get();
    if (
      !opts?.force &&
      state.autoCheckinConfig &&
      Date.now() - state.autoCheckinConfigAt < CONFIG_TTL_MS
    ) {
      return null;
    }
    try {
      const config = await api.getAutoCheckinConfig();
      set({ autoCheckinConfig: config, autoCheckinConfigAt: Date.now() });
      return null;
    } catch (e) {
      return api.asError(e);
    }
  },

  async ensureAutoTravelConfig(opts) {
    const state = get();
    if (
      !opts?.force &&
      state.autoTravelConfig &&
      Date.now() - state.autoTravelConfigAt < CONFIG_TTL_MS
    ) {
      return null;
    }
    try {
      const config = await api.getAutoTravelConfig();
      set({ autoTravelConfig: config, autoTravelConfigAt: Date.now() });
      return null;
    } catch (e) {
      return api.asError(e);
    }
  },

  async ensureAppStatus(variant, opts) {
    if (appStatusInflight?.variant === variant) return appStatusInflight.promise;
    const now = Date.now();
    const s = get();
    const stale = (at: number) => opts?.force === true || at === 0 || now - at > APP_STATUS_TTL_MS;
    const needCli = stale(s.codebuddyCliAt);
    const needIde = stale(s.codebuddyCnIdeAt);
    const needVscode = stale(s.vscodeExtAt);
    const needDetect =
      opts?.force === true || s.detectAt === 0 || now - s.detectAt > DETECT_TTL_MS;
    if (!needCli && !needIde && !needVscode && !needDetect) return;

    const promise = (async () => {
      try {
        // 探测会把当前账号写回后端状态文件，是后面 status 的数据来源，必须先跑
        if (needDetect && !api.isDemoMode()) {
          try {
            // 国际版探测 CodeBuddy.app 钥匙串；国内版探测 CodeBuddy CN。不要交叉读。
            if (variantUsesIntlCodebuddyIde(variant)) {
              await api.detectCodebuddyIdeAccount();
            } else {
              await api.detectCodebuddyCnIdeAccount();
            }
          } catch {
            /* 未登录或钥匙串拒绝时静默 */
          }
          try {
            await api.detectVscodeExtAccount();
          } catch {
            /* VS Code 未登录或 Safe Storage 不可用时静默 */
          }
          set({ detectAt: Date.now() });
        }

        const tasks: Promise<void>[] = [];
        if (needCli) {
          tasks.push(
            api
              .getCodebuddyCliStatus()
              .then((value) => set({ codebuddyCli: value, codebuddyCliAt: Date.now() }))
              .catch(() => set({ codebuddyCli: null, codebuddyCliAt: Date.now() })),
          );
        }
        if (needIde) {
          tasks.push(
            (variantUsesIntlCodebuddyIde(variant)
              ? api.getCodebuddyIdeStatus()
              : api.getCodebuddyCnIdeStatus()
            )
              .then((value) => set({ codebuddyCnIde: value, codebuddyCnIdeAt: Date.now() }))
              .catch(() => set({ codebuddyCnIde: null, codebuddyCnIdeAt: Date.now() })),
          );
        }
        if (needVscode) {
          tasks.push(
            api
              .getVscodeExtStatus()
              .then((value) => set({ vscodeExt: value, vscodeExtAt: Date.now() }))
              .catch(() => set({ vscodeExt: null, vscodeExtAt: Date.now() })),
          );
        }
        await Promise.all(tasks);
      } finally {
        // 只清自己这一轮：期间若已切到另一档位，新档位的在途请求不能被清掉。
        if (appStatusInflight?.variant === variant) appStatusInflight = undefined;
      }
    })();
    appStatusInflight = { variant, promise };
    return promise;
  },

  setAutoCheckinConfig(config) {
    set({ autoCheckinConfig: config, autoCheckinConfigAt: Date.now() });
  },

  setAutoTravelConfig(config) {
    set({ autoTravelConfig: config, autoTravelConfigAt: Date.now() });
  },

  forgetAccount(accountId) {
    set((s) => {
      const checkinMap = { ...s.checkinMap };
      const checkinAtMap = { ...s.checkinAtMap };
      const travelMap = { ...s.travelMap };
      const travelAtMap = { ...s.travelAtMap };
      const rateLimitMap = { ...s.rateLimitMap };
      delete checkinMap[accountId];
      delete checkinAtMap[accountId];
      delete travelMap[accountId];
      delete travelAtMap[accountId];
      delete rateLimitMap[accountId];
      return { checkinMap, checkinAtMap, travelMap, travelAtMap, rateLimitMap };
    });
  },

  invalidateCheckin(accountIds) {
    // 只清时间戳、保留旧值：卡片继续显示上一次结果，直到新结果回来
    api.invalidateCheckinBatch();
    set((s) => {
      if (!accountIds) return { checkinAtMap: {} };
      const checkinAtMap = { ...s.checkinAtMap };
      for (const id of accountIds) delete checkinAtMap[id];
      return { checkinAtMap };
    });
  },

  markCheckedIn(accountIds) {
    if (accountIds.length === 0) return;
    const now = Date.now();
    set((s) => {
      const checkinMap: Record<string, boolean> = { ...s.checkinMap };
      const checkinAtMap: Record<string, number> = { ...s.checkinAtMap };
      for (const id of accountIds) {
        checkinMap[id] = true;
        checkinAtMap[id] = now;
      }
      return { checkinMap, checkinAtMap };
    });
  },

  invalidateTravel(accountIds) {
    api.invalidateTravelBatch();
    set((s) => {
      if (!accountIds) return { travelAtMap: {} };
      const travelAtMap = { ...s.travelAtMap };
      for (const id of accountIds) delete travelAtMap[id];
      return { travelAtMap };
    });
  },

  invalidateRateLimits() {
    set({ rateLimitAt: 0 });
  },

  invalidateConfig() {
    set({ rateLimitConfigAt: 0, autoCheckinConfigAt: 0, autoTravelConfigAt: 0 });
  },
}));
