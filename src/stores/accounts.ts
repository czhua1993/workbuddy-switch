import { create } from "zustand";
import * as api from "@/lib/api";
import { DEFAULT_VARIANT, normalizeVariant } from "@/lib/variant";
import type { AccountMeta, AppStatus, CreditExpiry, WbVariant } from "@/lib/types";

/** In-flight credit fetches, shared so a remount does not start a second round. */
const creditInflight = new Set<string>();
/** 状态查询按档位各留一个在途请求，避免切档位时复用另一档位的结果。 */
let statusInflight: { variant: WbVariant; promise: Promise<AppStatus> } | undefined;
/** 已在途的 fetchAll：切 Tab / 切档位并发触发时只发一轮。 */
let fetchAllInflight: { variant: WbVariant; promise: Promise<void> } | undefined;
let lastFetchAllAt = 0;
/**
 * 已有数据时的最小重拉间隔。
 * 切 Tab 会重新挂载账号页，没有这道闸门时来回切换会反复打同一批请求。
 */
const FETCH_ALL_MIN_INTERVAL_MS = 5 * 1000;

function fetchStatus(variant: WbVariant): Promise<AppStatus> {
  if (!statusInflight || statusInflight.variant !== variant) {
    const promise = api.getStatus(variant).finally(() => {
      if (statusInflight?.promise === promise) statusInflight = undefined;
    });
    statusInflight = { variant, promise };
  }
  return statusInflight.promise;
}

async function fetchCreditExpiry(id: string): Promise<CreditExpiry> {
  try {
    return await api.getCreditExpiry(id);
  } catch (e) {
    return { ok: false, error: api.asError(e) };
  }
}

interface AccountsState {
  accounts: AccountMeta[];
  /**
   * 全局当前档位：状态、本机导入、轮询都以它为准。
   * 缺省国内版，因此在未引入档位切换时行为与改造前一致。
   */
  variant: WbVariant;
  status: AppStatus | null;
  loading: boolean;
  error: string | null;
  creditMap: Record<string, CreditExpiry>;
  creditLoadingMap: Record<string, boolean>;
  /** 账号 id -> 最近一次积分查询完成时间（成功/失败都记录） */
  creditUpdatedAtMap: Record<string, number>;
  refreshingCredits: boolean;
  lastCreditRefreshAt: number;
  setVariant: (variant: WbVariant) => void;
  /** `force`：忽略最小重拉间隔（切档位、导入、签到后等状态确实变了的场景）。 */
  fetchAll: (opts?: { force?: boolean }) => Promise<void>;
  refreshStatus: (signal?: AbortSignal) => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
  /** Fetch credits only for ids not already cached. */
  ensureCredits: (accountIds: string[]) => Promise<void>;
  /** Force-refresh credits. `silent` skips toolbar/card loading flicker (timer). */
  refreshCredits: (accountIds: string[], opts?: { silent?: boolean }) => Promise<void>;
  importLocal: () => Promise<AccountMeta>;
  reconcileAccounts: () => Promise<void>;
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  variant: DEFAULT_VARIANT,
  status: null,
  loading: false,
  error: null,
  creditMap: {},
  creditLoadingMap: {},
  creditUpdatedAtMap: {},
  refreshingCredits: false,
  lastCreditRefreshAt: 0,

  setVariant(variant) {
    const next = normalizeVariant(variant);
    if (get().variant === next) return;
    // 状态卡（运行中 / 当前账号 / 应用路径）随档位整体换一份：先清空，
    // 否则会短暂显示上一档位的运行/当前账号状态。
    set({ variant: next, status: null });
    void get().fetchAll({ force: true });
  },

  async fetchAll(opts) {
    const variant = get().variant;
    if (fetchAllInflight?.variant === variant) return fetchAllInflight.promise;

    const hasData = get().accounts.length > 0 || get().status !== null;
    if (!opts?.force && hasData && Date.now() - lastFetchAllAt < FETCH_ALL_MIN_INTERVAL_MS) {
      return;
    }
    // 已有数据时静默刷新：置 loading 会让切回账号页闪一下「加载账号…」。
    if (hasData) set({ error: null });
    else set({ loading: true, error: null });

    const promise = (async () => {
      try {
        const [status, { accounts }] = await Promise.all([fetchStatus(variant), api.getAccounts()]);
        // 迟到结果不得覆盖已切换档位的状态。
        if (get().variant !== variant) return;
        set({ status, accounts, loading: false });
        lastFetchAllAt = Date.now();
      } catch (e) {
        if (get().variant !== variant) return;
        set({ error: api.asError(e), loading: false });
      } finally {
        // 只清自己这一轮：期间若已切到另一档位，新档位的在途请求不能被清掉。
        if (fetchAllInflight?.variant === variant) fetchAllInflight = undefined;
      }
    })();
    fetchAllInflight = { variant, promise };
    return promise;
  },

  async refreshStatus(signal) {
    const variant = get().variant;
    try {
      const status = await fetchStatus(variant);
      if (!signal?.aborted && get().variant === variant) set({ status });
    } catch {
      // 后台探测失败时保留最后一次成功状态，下一轮轮询继续尝试。
    }
  },

  async deleteAccount(id: string) {
    await api.deleteAccount(id);
    creditInflight.delete(id);
    const { creditMap, creditLoadingMap, creditUpdatedAtMap } = get();
    const nextCredits = { ...creditMap };
    const nextLoading = { ...creditLoadingMap };
    const nextUpdatedAt = { ...creditUpdatedAtMap };
    delete nextCredits[id];
    delete nextLoading[id];
    delete nextUpdatedAt[id];
    set({
      accounts: get().accounts.filter((a) => a.id !== id),
      creditMap: nextCredits,
      creditLoadingMap: nextLoading,
      creditUpdatedAtMap: nextUpdatedAt,
    });
  },

  async ensureCredits(accountIds) {
    await loadCredits(accountIds, false, false);
  },

  async refreshCredits(accountIds, opts) {
    await loadCredits(accountIds, true, opts?.silent === true);
  },

  async importLocal() {
    // 本机导入按当前档位读取对应登录态文件。
    const res = await api.importLocal(get().variant);
    await get().reconcileAccounts();
    return res.account;
  },

  async reconcileAccounts() {
    const { accounts } = await api.getAccounts();
    set({ accounts });
  },
}));

async function loadCredits(accountIds: string[], force: boolean, silent: boolean) {
  const ids = [...new Set(accountIds.filter(Boolean))];
  if (ids.length === 0) return;

  const state = useAccountsStore.getState();
  const toFetch = force
    ? ids
    : ids.filter((id) => state.creditMap[id] === undefined && !creditInflight.has(id));
  if (toFetch.length === 0) return;

  for (const id of toFetch) creditInflight.add(id);
  if (!silent) {
    useAccountsStore.setState((s) => {
      const creditLoadingMap = { ...s.creditLoadingMap };
      for (const id of toFetch) creditLoadingMap[id] = true;
      return {
        creditLoadingMap,
        refreshingCredits: force ? true : s.refreshingCredits,
      };
    });
  }

  await Promise.all(
    toFetch.map(async (id) => {
      const result = await fetchCreditExpiry(id);
      creditInflight.delete(id);
      useAccountsStore.setState((s) => ({
        creditMap: { ...s.creditMap, [id]: result },
        creditUpdatedAtMap: { ...s.creditUpdatedAtMap, [id]: Date.now() },
        creditLoadingMap: silent ? s.creditLoadingMap : { ...s.creditLoadingMap, [id]: false },
      }));
    }),
  );

  useAccountsStore.setState((s) => ({
    lastCreditRefreshAt: Date.now(),
    refreshingCredits: silent ? s.refreshingCredits : force ? false : s.refreshingCredits,
  }));
}
