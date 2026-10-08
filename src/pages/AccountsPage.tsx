import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  Columns3,
  ExternalLink,
  FileDown,
  FileUp,
  Loader2,
  QrCode,
  RefreshCw,
  Rows3,
  Terminal,
} from "lucide-react";

import { AccountCard } from "@/components/account-card";
import { AccountInfoDialog } from "@/components/account-info-dialog";
import { CleanupSessionsDialog } from "@/components/cleanup-sessions-dialog";
import { DedupSessionsDialog } from "@/components/dedup-sessions-dialog";
import { JetbrainsSwitchDialog } from "@/components/jetbrains-switch-dialog";
import { CodebuddyIdeSwitchAccountDialog } from "@/components/codebuddy-ide-switch-account-dialog";
import { DemoAction } from "@/components/demo-action";
import {
  CodeBuddyAiIdeMark,
  CodeBuddyCnIdeMark,
  CodeBuddyMark,
  JetbrainsMark,
  VscodeExtMark,
  WorkBuddyAiMark,
  WorkBuddyMark,
} from "@/components/product-marks";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExportAccountsDialog } from "@/components/export-accounts-dialog";
import { ImportAccountsDialog } from "@/components/import-accounts-dialog";
import { OAuthLoginDialog } from "@/components/oauth-login-dialog";
import { SwitchAccountDialog } from "@/components/switch-account-dialog";
import { VscodeSwitchAccountDialog } from "@/components/vscode-switch-account-dialog";
import * as api from "@/lib/api";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import {
  accountVariant,
  normalizeVariant,
  variantAppName,
  DEFAULT_VARIANT,
  variantCodebuddyIdeName,
  variantDownloadDomain,
  variantLabel,
  variantSupportsCheckin,
  variantSupportsTravel,
  variantUsesIntlCodebuddyIde,
} from "@/lib/variant";
import { useSupportedTools } from "@/lib/supported-tools";
import type { AccountMeta, AppStatus, CreditExpiry } from "@/lib/types";
import { displayName } from "@/lib/account-display";
import { cn } from "@/lib/utils";
import { useAccountsStore } from "@/stores/accounts";
import { useAccountStatusStore } from "@/stores/account-status";

/**
 * 账号页两个轮询的间隔（都经 `useVisibleInterval` 门控，仅主窗口可见时执行）。
 *
 * - 旅行：后台派发/领取循环最快 15 分钟变一次状态，1 分钟用于及时反映"到期领取"后的显示；
 * - 限额：CLI / WorkBuddy 由后端 hook 信号实时入账并推送（`rate-limits-updated`），
 *   这里只兜底 IDE 日志扫描；后端按同一间隔节流扫描，前端再按 payload 的 `scannedAt`
 *   判断「距上次扫描 ≥ 5 分钟」才发起，避免可见性切换/页面重挂载把扫描打散。
 */
const TRAVEL_REFRESH_INTERVAL_MS = 60 * 1000;
const RATE_LIMIT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/**
 * CodeBuddy CLI 认证状态的重读间隔。
 *
 * 保活刷新会先批量改写账号库里的 token、再把新 token 同步回
 * `~/.codebuddy/settings.json`。这个窗口里状态判定会短暂认为「认证已脱节」。
 * 后端在刷新前后各广播一次 `codebuddy-cli-updated`（见 lib.rs 保活循环），
 * 这里再挂一个可见时轮询兜底：即使事件因窗口未挂载而错过，横幅也会自行收掉。
 */
const CLI_STATUS_REFRESH_INTERVAL_MS = 30 * 1000;

function expiringSoonAmount(credit?: CreditExpiry): number {
  return credit?.ok ? credit.expiringSoonRemaining ?? 0 : 0;
}

function hasExpiringSoonCredits(credit?: CreditExpiry): boolean {
  return credit?.ok === true && expiringSoonAmount(credit) > 0;
}

function soonestRelevantExpiry(credit?: CreditExpiry): number {
  const soonestExpiringCredit = (credit?.resources ?? [])
    .filter((resource) => resource.remaining > 0 && resource.expiringSoon && resource.expireAt != null)
    .map((resource) => resource.expireAt as number)
    .reduce((soonest, expireAt) => Math.min(soonest, expireAt), Number.POSITIVE_INFINITY);
  return Number.isFinite(soonestExpiringCredit)
    ? soonestExpiringCredit
    : credit?.soonestExpireAt ?? Number.POSITIVE_INFINITY;
}

function creditPriorityRank(credit?: CreditExpiry): number {
  if (!credit?.ok) return 3;
  if (hasExpiringSoonCredits(credit)) return 0;
  if (credit.expired) return 1;
  return 2;
}

function isWorkbuddyCurrent(account: AccountMeta, current: AppStatus["current"] | undefined): boolean {
  if (!current) return false;
  return Boolean(
    (current.uid && (account.uid === current.uid || account.id === current.uid)) ||
      (current.email && account.email === current.email),
  );
}

export default function AccountsPage() {
  const {
    accounts,
    variant,
    setVariant,
    status,
    loading,
    error,
    fetchAll,
    deleteAccount,
    importLocal,
    creditMap,
    creditLoadingMap,
    creditUpdatedAtMap,
    refreshingCredits,
    ensureCredits,
    refreshCredits,
    clientStatus,
    setClientStatus,
  } = useAccountsStore();
  const {
    checkinMap,
    travelMap,
    rateLimitMap,
    rateLimitEnabled,
    autoCheckinConfig,
    autoTravelConfig,
    codebuddyCli,
    codebuddyCnIde,
    vscodeExt,
    ensureCheckin,
    ensureTravel,
    ensureRateLimits,
    ensureRateLimitConfig,
    ensureAutoCheckinConfig,
    ensureAutoTravelConfig,
    ensureAppStatus,
    setAutoCheckinConfig,
    setAutoTravelConfig,
    forgetAccount,
    markCheckedIn,
  } = useAccountStatusStore();
  const [oauthOpen, setOauthOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [switchAccount, setSwitchAccount] = useState<AccountMeta | null>(null);
  const [cleanupSessionsAccount, setCleanupSessionsAccount] = useState<AccountMeta | null>(null);
  const [dedupSessionsAccount, setDedupSessionsAccount] = useState<AccountMeta | null>(null);
  /** 「账号信息」弹框目标账号（查看信息 / 编辑备注 / 选择显示字段）。 */
  const [infoTarget, setInfoTarget] = useState<AccountMeta | null>(null);
  const [autoCheckinSaving, setAutoCheckinSaving] = useState(false);
  const [autoTravelSaving, setAutoTravelSaving] = useState(false);
  /** 配置是否已读取完毕（成功或失败）：区分「尚未读到」与「读取失败」。 */
  const [autoCheckinSettled, setAutoCheckinSettled] = useState(false);
  /**
   * 各客户端状态（CLI / CodeBuddy IDE / VS Code）由 status store 缓存；JetBrains 不
   * 在共享 store 里，仍从账号 store 的 `clientStatus` 取。
   */
  const { jetbrains } = clientStatus;
  const [codebuddyCliSwitchingId, setCodebuddyCliSwitchingId] = useState<string | null>(null);
  /** CodeBuddy IDE 切换弹窗目标（null=关闭）；切换与可选会话复制/同步在弹窗内完成（国内版 / 国际版共用）。 */
  const [codebuddyIdeSwitchAccount, setCodebuddyIdeSwitchAccount] = useState<AccountMeta | null>(null);
  /** VS Code 扩展切换弹窗目标（null=关闭）；切换与可选会话复制在弹窗内完成。 */
  const [vscodeSwitchAccount, setVscodeSwitchAccount] = useState<AccountMeta | null>(null);
  /** JetBrains 切换弹窗目标（null=关闭）；切换与目标 IDE 选择在弹窗内完成。 */
  const [jetbrainsSwitchTarget, setJetbrainsSwitchTarget] = useState<AccountMeta | null>(null);
  const [installingCodebuddyCli, setInstallingCodebuddyCli] = useState(false);
  /** 刷新按钮触发的批量签到进行中 */
  const [checkinAllRunning, setCheckinAllRunning] = useState(false);
  /** 接入/升级 CLI helper 确认框 */
  const [installConfirmOpen, setInstallConfirmOpen] = useState(false);
  /** 切换 CodeBuddy CLI 确认目标（null=关闭） */
  const [cliSwitchTarget, setCliSwitchTarget] = useState<AccountMeta | null>(null);
  /** 删除账号确认目标（null=关闭） */
  const [deleteTarget, setDeleteTarget] = useState<AccountMeta | null>(null);
  /** 当前档位下的账号：列表、计数、签到、积分等一律只作用于当前档位。 */
  const visibleAccounts = useMemo(
    () => accounts.filter((account) => accountVariant(account) === variant),
    [accounts, variant],
  );
  const appName = variantAppName(variant);
  const travelAvailable = variantSupportsTravel(variant);
  const checkinAvailable = variantSupportsCheckin(variant);
  /** 旅行 chip 与旅行状态轮询只在自动旅行开启后生效（配置未读到 = 未开启）。 */
  const autoTravelEnabled = travelAvailable && autoTravelConfig?.enabled === true;
  const autoCheckinEnabled = autoCheckinConfig?.enabled ?? false;
  /** 刷新按钮文案：国际版没有签到接口，只刷新积分。 */
  const refreshCreditsLabel = checkinAvailable ? "刷新全部账号积分并签到（仅在签到时间段内签到；忽略已关闭自动签到的账号）" : "刷新全部账号积分";
  /** 关闭自动签到的账号 id（配置未读到/读取失败 = 空名单）。 */
  const excludedCheckinIds = useMemo(
    () => new Set(autoCheckinConfig?.excluded_account_ids ?? []),
    [autoCheckinConfig],
  );
  /** 今日签到状态只查未关闭自动签到的账号；配置就绪前不发请求。 */
  const autoCheckinAccountIds = useMemo(() => {
    if (!checkinAvailable || !autoCheckinSettled) return [];
    return visibleAccounts
      .filter((account) => !excludedCheckinIds.has(account.id))
      .map((account) => account.id);
  }, [visibleAccounts, checkinAvailable, autoCheckinSettled, excludedCheckinIds]);
  /** 紧凑模式：卡片更小、同屏更多列；默认开启，持久化到 localStorage */
  const [compact, setCompact] = useState<boolean>(() => {
    try {
      return localStorage.getItem("wb-switch.compact") !== "0";
    } catch {
      return true;
    }
  });

  /**
   * 支持工具开关（设置页）：关闭的端不渲染入口、不轮询状态。
   * 缺省 = 现有四端开、JetBrains 关（与 `src/lib/supported-tools.ts` 的默认值一致）。
   */
  const enabledTools = useSupportedTools();

  function toggleCompact() {
    setCompact((value) => {
      const next = !value;
      try {
        localStorage.setItem("wb-switch.compact", next ? "1" : "0");
      } catch {
        /* 存储不可用时静默 */
      }
      return next;
    });
  }

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    let cancelled = false;
    void ensureAutoCheckinConfig().finally(() => {
      if (!cancelled) setAutoCheckinSettled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [ensureAutoCheckinConfig]);

  async function refreshCodebuddyCliStatus() {
    try {
      setClientStatus({ codebuddyCli: await api.getCodebuddyCliStatus() });
    } catch {
      setClientStatus({ codebuddyCli: null });
    }
  }

  async function refreshCodebuddyCnIdeStatus() {
    try {
      setClientStatus({
        codebuddyCnIde: variantUsesIntlCodebuddyIde(variant)
          ? await api.getCodebuddyIdeStatus()
          : await api.getCodebuddyCnIdeStatus(),
      });
    } catch {
      setClientStatus({ codebuddyCnIde: null });
    }
  }

  async function refreshVscodeExtStatus() {
    try {
      setClientStatus({ vscodeExt: await api.getVscodeExtStatus() });
    } catch {
      setClientStatus({ vscodeExt: null });
    }
  }

  /**
   * 首次启动自动导入本机账号（本会话只尝试一次，无本机账号时静默）。
   * 仅限默认档位：切到国际版时不静默写入账号，改由空状态引导显式导入或浏览器授权登录。
   */
  const autoImportTried = useRef(false);
  useEffect(() => {
    if (variant !== DEFAULT_VARIANT) return;
    if (autoImportTried.current || loading || visibleAccounts.length > 0) return;
    autoImportTried.current = true;
    void importLocal()
      .then(() => void fetchAll())
      .catch(() => {
        /* 本机无 WorkBuddy 登录态时静默，不打扰用户 */
      });
  }, [variant, visibleAccounts.length, loading, importLocal, fetchAll]);

  async function refreshJetbrainsStatus() {
    try {
      setClientStatus({ jetbrains: await api.getJetbrainsStatus() });
    } catch {
      setClientStatus({ jetbrains: null });
    }
  }

  useEffect(() => {
    if (enabledTools.codebuddyCli || enabledTools.codebuddyIde || enabledTools.vscodeExt) {
      void ensureAppStatus(variant);
    }
  }, [
    accounts.length,
    variant,
    enabledTools.codebuddyCli,
    enabledTools.codebuddyIde,
    enabledTools.vscodeExt,
    ensureAppStatus,
  ]);

  useEffect(() => {
    if (!enabledTools.jetbrains) return;
    let cancelled = false;
    // 支持工具关闭的端：既不探测也不轮询（与入口隐藏保持一致，省掉无谓请求）。
    if (enabledTools.codebuddyCli) void refreshCodebuddyCliStatus();

    /**
     * 读各端状态（安装 / 运行 / 当前账号）：只读本地状态文件与进程，不碰钥匙串，
     * 因此不必等下面的本机登录探测。
     */
    async function refreshClientStatuses() {
      if (cancelled) return;
      if (enabledTools.codebuddyIde) await refreshCodebuddyCnIdeStatus();
      if (cancelled) return;
      if (enabledTools.vscodeExt) await refreshVscodeExtStatus();
      if (cancelled) return;
      if (enabledTools.jetbrains) await refreshJetbrainsStatus();
    }

    void (async () => {
      // 状态刷新与登录探测并行起跑：探测要读钥匙串 / Safe Storage / 注册表 / 进程
      // （macOS 可能等待系统授权、Windows 走 PowerShell，耗时可达数秒），排在状态
      // 前面会让「已接入」迟迟不显示（issue #84）。
      const statuses = refreshClientStatuses();
      if (!api.isDemoMode()) {
        try {
          await api.detectJetbrainsAccount();
        } catch {
          /* JetBrains 插件未登录时静默 */
        }
      }
      await statuses;
      // 探测命中账号时后端会把「当前账号」写回本地状态，再读一次让高亮跟上。
      if (!cancelled) await refreshClientStatuses();
    })();
    return () => {
      cancelled = true;
    };
  }, [accounts.length, variant, enabledTools.jetbrains]);

  // 配置就绪后查询未关闭自动签到的账号；国际版没有签到接口，不查询状态。
  useEffect(() => {
    if (!autoCheckinAccountIds.length) return;
    void ensureCheckin(autoCheckinAccountIds);
  }, [autoCheckinAccountIds, ensureCheckin]);

  useEffect(() => {
    if (!travelAvailable) return;
    void ensureAutoTravelConfig();
  }, [travelAvailable, ensureAutoTravelConfig]);

  const travelAccountIds = useMemo(
    () => visibleAccounts.map((account) => account.id),
    [visibleAccounts],
  );
  useVisibleInterval(
    () => void ensureTravel(travelAccountIds),
    TRAVEL_REFRESH_INTERVAL_MS,
    autoTravelEnabled && travelAccountIds.length > 0,
  );

  /**
   * 模型限额台账由共享 store 缓存；页面只负责可见时轮询和响应后端实时事件。
   */
  useEffect(() => {
    void ensureRateLimitConfig();
  }, [ensureRateLimitConfig]);

  // 事件监听与定时器都需要「最新」的刷新函数：直接闭包捕获会在状态更新后仍然
  // 指向旧引用，导致拉回的仍是挂载时的旧判断（限额台账改由 status store 负责）。
  const refreshCodebuddyCliStatusRef = useRef(refreshCodebuddyCliStatus);
  refreshCodebuddyCliStatusRef.current = refreshCodebuddyCliStatus;

  useVisibleInterval(
    () => void ensureRateLimits(),
    RATE_LIMIT_REFRESH_INTERVAL_MS,
    rateLimitEnabled === true,
  );

  useEffect(() => {
    if (api.isWebui()) return;
    let unlisten: (() => void) | undefined;
    void listen("rate-limits-updated", () => {
      void ensureRateLimits({ force: true });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  /**
   * CLI 认证状态变化（保活刷新前后、切换账号、接入 helper）→ 立即重读。
   *
   * 没有这一路时，页面只在挂载时读一次状态：若恰好落在保活刷新的中间态，
   * 判出来的「认证已脱节」会一直留在页面上，用户点什么都要等下次重挂载。
   */
  useEffect(() => {
    if (api.isWebui()) return;
    let unlisten: (() => void) | undefined;
    void listen("codebuddy-cli-updated", () => {
      void refreshCodebuddyCliStatusRef.current();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // 兜底轮询：事件可能因窗口尚未挂载而错过（例如后台刷新先于页面加载完成），
  // 仅主窗口可见时执行，保证横幅最终一定会自愈。
  useVisibleInterval(
    () => void refreshCodebuddyCliStatusRef.current(),
    CLI_STATUS_REFRESH_INTERVAL_MS,
    true,
  );

  // 「限额监听」开关由 status store 的 `ensureRateLimitConfig` 读取，页面不再单独拉取。

  // 只给尚未缓存的账号拉积分；切回首页不重复请求。点「刷新积分」才强制更新。
  useEffect(() => {
    if (!visibleAccounts.length) return;
    void ensureCredits(visibleAccounts.map((account) => account.id));
  }, [visibleAccounts, ensureCredits]);

  /** 导出完成提示（含安全提醒）。 */
  function onExported(count: number) {
    const text = `已导出 ${count} 个账号。文件含登录 token，等同密码，请勿上传网盘或发送给他人。`;
    toast.success("导出成功", { description: text });
  }

  /** 导入完成提示：计数 + token 可能过期提醒（含加密凭据能力限制），并刷新列表。 */
  function onImported(result: {
    imported: number;
    skipped: number;
    overwritten: number;
    encrypted: number;
  }) {
    void fetchAll();
    const overwriteText = result.overwritten > 0 ? `（覆盖 ${result.overwritten} 个）` : "";
    const encryptedText =
      result.encrypted > 0
        ? `其中 ${result.encrypted} 个为加密凭据，仅可用于切换，签到/积分不可用。`
        : "";
    const text = `已导入 ${result.imported} 个${overwriteText}，跳过 ${result.skipped} 个。${encryptedText}token 可能已过期，切换后可能需要重新登录。`;
    toast.success("导入成功", { description: text });
  }

  async function onToggleAutoCheckin(enabled: boolean) {
    const previous = autoCheckinConfig;
    if (!previous || autoCheckinSaving) return;
    setAutoCheckinSaving(true);
    setAutoCheckinConfig({ ...previous, enabled });
    try {
      const saved = await api.saveAutoCheckinConfig({ ...previous, enabled });
      setAutoCheckinConfig(saved);
      toast.success(enabled ? "自动签到已开启" : "自动签到已关闭");
    } catch (error) {
      setAutoCheckinConfig(previous);
      toast.error("自动签到设置保存失败", { description: api.asError(error) });
    } finally {
      setAutoCheckinSaving(false);
    }
  }

  async function onToggleAutoTravel(enabled: boolean) {
    const previous = autoTravelConfig;
    if (!previous || autoTravelSaving) return;
    setAutoTravelSaving(true);
    setAutoTravelConfig({ ...previous, enabled });
    try {
      const saved = await api.saveAutoTravelConfig({ ...previous, enabled });
      setAutoTravelConfig(saved);
      toast.success(enabled ? "自动旅行已开启" : "自动旅行已关闭");
    } catch (error) {
      setAutoTravelConfig(previous);
      toast.error("自动旅行设置保存失败", { description: api.asError(error) });
    } finally {
      setAutoTravelSaving(false);
    }
  }

  async function onDelete(a: AccountMeta) {
    // 桌面 App（Tauri WebView）不支持 window.confirm，改用 Dialog 确认
    setDeleteTarget(a);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const a = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteAccount(a.id);
      forgetAccount(a.id);
      toast.success("账号已删除");
    } catch (e) {
      toast.error("删除失败", { description: api.asError(e) });
    }
  }

  async function onCheckin(a: AccountMeta) {
    try {
      const res = await api.checkin(a.id);
      const label =
        res.result === "success"
          ? "签到成功"
          : res.result === "already"
            ? "今天已签到"
            : "签到失败";
      const description = `${displayName(a)}${res.error ? `：${res.error}` : ""}`;
      if (res.result === "error") toast.error(label, { description });
      else toast.success(label, { description });
      // 手动签到已完成状态核验，直接使用回执，避免为已关闭账号再触发展示查询。
      if (res.result === "success" || res.result === "already") {
        markCheckedIn([a.id]);
      }
      void fetchAll();
      // 签到成功/已签到会带来积分变动，force 刷新该账号积分
      if (res.result !== "error") void refreshCredits([a.id]);
    } catch (e) {
      toast.error("签到失败", { description: api.asError(e) });
    }
  }

  async function onRefresh(a: AccountMeta) {
    try {
      const res = await api.refreshAccountToken(a.id);
      const label = displayName(a);
      if (res.needsRelogin) {
        toast.error("Token 刷新失败", { description: `${label}：需重新登录${res.needsReloginReason ? `（${res.needsReloginReason}）` : ""}` });
      } else {
        toast.success("Token 已刷新", { description: label });
      }
      void fetchAll();
    } catch (e) {
      toast.error("Token 刷新失败", { description: api.asError(e) });
    }
  }

  /** 刷新附带的签到遵守账号开关与签到时间段；所有账号照常刷新积分，提示实际忽略/未到时间段数量。 */
  async function onRefreshCredits() {
    if (!visibleAccounts.length || refreshingCredits || checkinAllRunning) return;
    setCheckinAllRunning(true);
    const ids = visibleAccounts.map((account) => account.id);
    let summary = "";
    let notify = toast.success;
    let title = "积分到期情况已刷新";
    try {
      if (checkinAvailable) {
        try {
          const res = await api.checkinAll(variant, true);
          const entries = res.accounts ?? [];
          const success = entries.filter((e) => e.result === "success").length;
          const already = entries.filter((e) => e.result === "already").length;
          const failed = entries.filter((e) => e.result === "error").length;
          const inactive = entries.filter((e) => e.inactive === true || e.result === "inactive").length;
          const skipped = entries.filter((e) => e.result === "skipped" && e.reason === "auto_checkin_disabled").length;
          const outsideWindow = entries.filter((e) => e.result === "skipped" && e.reason === "outside_checkin_window").length;
          const parts: string[] = [];
          if (success > 0) parts.push(`${success} 个签到成功`);
          if (already > 0) parts.push(`${already} 个已签到`);
          if (inactive > 0) parts.push(`${inactive} 个未开放签到`);
          if (failed > 0) parts.push(`${failed} 个失败`);
          if (skipped > 0) parts.push(`已忽略 ${skipped} 个关闭自动签到的账号`);
          if (outsideWindow > 0) parts.push(`${outsideWindow} 个未到签到时间段`);
          summary = res.status === "skipped" && res.reason === "already_running"
            ? "签到任务正在进行，本次仅刷新积分"
            : parts.length > 0 ? parts.join("，") : "无账号需要签到";
          const allFailed = entries.length > 0 && failed === entries.length;
          const allSkippedOrInactive =
            res.status === "skipped" ||
            entries.length === 0 ||
            (success === 0 && already === 0 && failed === 0);
          if (allFailed) {
            // 全部失败：没有成功、已签、未开放或忽略的账号。
            notify = toast.error;
            title = "积分已刷新，签到出现错误";
          } else if (allSkippedOrInactive) {
            // 全部被跳过或官方未开放签到活动：既不算成功也不算失败，不呈现为绿色成功。
            notify = toast.info;
          }
          // 只重查实际处理过的账号状态；被跳过的账号本次未发请求，状态保持未知。
          await ensureCheckin(
            entries.filter((entry) => entry.result !== "skipped").map((entry) => entry.accountId),
            { force: true },
          );
        } catch (e) {
          notify = toast.error;
          title = "积分已刷新，签到出现错误";
          summary = api.asError(e);
        }
      }
      await refreshCredits(ids);
      if (autoTravelEnabled) await ensureTravel(ids, { force: true });
      notify(title, { description: summary || undefined });
    } finally {
      setCheckinAllRunning(false);
    }
  }

  async function onSwitchCodebuddyCli(account: AccountMeta) {
    if (codebuddyCliSwitchingId !== null) return;
    setCliSwitchTarget(account);
  }

  async function confirmSwitchCodebuddyCli() {
    const account = cliSwitchTarget;
    if (!account || codebuddyCliSwitchingId !== null) return;
    setCliSwitchTarget(null);
    setCodebuddyCliSwitchingId(account.id);
    const toastId = toast.loading("正在切换 CodeBuddy CLI…", {
      description: `正在将默认账号设为 ${displayName(account)}`,
    });
    try {
      // 后端一律先关闭正在运行的 CLI 再写状态（`closeRunningCli` 入参已废弃）。
      const result = await api.switchCodebuddyCliAccount(account.id);
      await ensureAppStatus(variant, { force: true });
      toast.success("CodeBuddy CLI 默认账号已更新", {
        id: toastId,
        description: `${displayName(account)}：${result.message || "配置已更新"}`,
      });
    } catch (error) {
      toast.error("CodeBuddy CLI 切换失败", {
        id: toastId,
        description: api.asError(error),
      });
    } finally {
      setCodebuddyCliSwitchingId(null);
    }
  }

  async function onSwitchCodebuddyCnIde(account: AccountMeta) {
    if (codebuddyIdeSwitchAccount !== null) return;
    // 国内版与国际版共用同一弹窗（关联会话 / 复制会话两个 tab），只有数据源与切换接口按档位分流；
    // 弹窗本身承担确认职责（不勾选时行为与一键切换一致），不再另设轻量确认框。
    setCodebuddyIdeSwitchAccount(account);
  }

  async function onInstallCodebuddyCli() {
    // 桌面 App（Tauri WebView）不支持 window.confirm，改用 Dialog 确认
    setInstallConfirmOpen(true);
  }

  async function confirmInstallCodebuddyCli() {
    setInstallConfirmOpen(false);
    setInstallingCodebuddyCli(true);
    try {
      const result = await api.installCodebuddyCliHelper();
      toast.success("CodeBuddy CLI 接入已更新", { description: result.message });
      await ensureAppStatus(variant, { force: true });
    } catch (error) {
      toast.error("CodeBuddy CLI 接入失败", { description: api.asError(error) });
    } finally {
      setInstallingCodebuddyCli(false);
    }
  }

  const current = status?.current;
  const creditOrderingReady =
    visibleAccounts.length > 0 &&
    visibleAccounts.every((account) => Boolean(creditMap[account.id]) && !creditLoadingMap[account.id]);
  const orderedAccounts = creditOrderingReady
    ? visibleAccounts
        .map((account, index) => ({ account, index }))
        .sort((left, right) => {
          const leftCredit = creditMap[left.account.id];
          const rightCredit = creditMap[right.account.id];
          const rankDifference = creditPriorityRank(leftCredit) - creditPriorityRank(rightCredit);
          if (rankDifference !== 0) return rankDifference;

          const leftExpiry = soonestRelevantExpiry(leftCredit);
          const rightExpiry = soonestRelevantExpiry(rightCredit);
          if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;

          const amountDifference = expiringSoonAmount(rightCredit) - expiringSoonAmount(leftCredit);
          if (amountDifference !== 0) return amountDifference;
          return left.index - right.index;
        })
        .map(({ account }) => account)
    : visibleAccounts;
  const priorityAccountId =
    creditOrderingReady
      ? orderedAccounts.find((account) => hasExpiringSoonCredits(creditMap[account.id]))?.id
      : undefined;
  const cliCurrentAccountId = codebuddyCli?.activeAccountId;
  const cliSwitchAccountLabel = cliSwitchTarget ? displayName(cliSwitchTarget) : "";
  const workbuddyCurrentName = current ? displayName(current) : "未登录";
  const codebuddyCurrentName = codebuddyCli?.configured
    ? codebuddyCli.activeAccountName || "未检测到"
    : "尚未接入";
  const cnIdeCurrentAccountId = codebuddyCnIde?.activeAccountId;
  const cnIdeCurrentName = codebuddyCnIde?.installed
    ? codebuddyCnIde.activeAccountName || "未检测到"
    : "未安装";
  const vscodeExtCurrentAccountId = vscodeExt?.activeAccountId;
  const vscodeExtCurrentName = vscodeExt?.installed
    ? vscodeExt.activeAccountName || "未检测到"
    : "未接入";
  const jetbrainsCurrentAccountId = jetbrains?.activeAccountId;
  const jetbrainsCurrentName = jetbrains?.installed
    ? jetbrains.activeAccountName || "未检测到"
    : "未接入";
  const codebuddyUsesSettingsEnv = codebuddyCli?.authMode === "settings-env";
  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 py-8 sm:px-8 sm:py-9">
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[28px] font-semibold tracking-tight">账号管理</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              统一管理 WorkBuddy、CodeBuddy IDE、CodeBuddy CLI 与 VS Code CodeBuddy 插件账号、积分和签到状态。
            </p>
            <Tabs
              className="mt-4 gap-0"
              value={variant}
              onValueChange={(value) => setVariant(normalizeVariant(value))}
            >
              <TabsList aria-label="WorkBuddy 档位">
                <TabsTrigger value="cn">国内版</TabsTrigger>
                <TabsTrigger value="ai">国际版</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="flex shrink-0 items-center gap-4 pt-1">
            <div className="flex items-center gap-2.5">
{enabledTools.workbuddy && (
              <span className="group relative inline-flex cursor-default">
                <span
                  className={
                    status?.running
                      ? "inline-flex rounded-[22%] bg-primary p-[2px] shadow-sm shadow-primary/40"
                      : "inline-flex rounded-[22%] bg-muted-foreground/30 p-[2px]"
                  }
                >
                  {variant === "ai" ? <WorkBuddyAiMark size={28} /> : <WorkBuddyMark size={28} />}
                </span>
                <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg ring-1 ring-black/5 group-hover:block">
                  {appName}：{status?.running ? "运行中" : "未运行"} · 当前账号：{workbuddyCurrentName}
                </span>
              </span>
            )}
{enabledTools.codebuddyIde && (
              <span className="group relative inline-flex cursor-default">
                <span
                  className={
                    codebuddyCnIde?.installed
                      ? "inline-flex rounded-[22%] bg-primary p-[2px] shadow-sm shadow-primary/40"
                      : "inline-flex rounded-[22%] bg-muted-foreground/30 p-[2px]"
                  }
                >
                  {variantUsesIntlCodebuddyIde(variant) ? (
                    <CodeBuddyAiIdeMark size={28} />
                  ) : (
                    <CodeBuddyCnIdeMark size={28} />
                  )}
                </span>
                <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg ring-1 ring-black/5 group-hover:block">
                  {variantCodebuddyIdeName(variant)}：{codebuddyCnIde?.installed ? (codebuddyCnIde.running ? "运行中" : "已接入") : "未接入"} · 当前账号：{cnIdeCurrentName}
                </span>
              </span>
            )}
{enabledTools.vscodeExt && (
              <span className="group relative inline-flex cursor-default">
                <span
                  className={
                    vscodeExt?.installed && vscodeExt?.extensionInstalled
                      ? "inline-flex rounded-[22%] bg-primary p-[2px] shadow-sm shadow-primary/40"
                      : "inline-flex rounded-[22%] bg-muted-foreground/30 p-[2px]"
                  }
                >
                  <VscodeExtMark size={28} />
                </span>
                <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg ring-1 ring-black/5 group-hover:block">
                  VS Code CodeBuddy 插件：{!vscodeExt?.installed ? "未检测到 VS Code" : !vscodeExt.extensionInstalled ? "未安装插件" : vscodeExt.running ? "运行中" : "已接入"} · 当前账号：{vscodeExtCurrentName}
                </span>
              </span>
            )}
{enabledTools.jetbrains && (
              <span className="group relative inline-flex cursor-default">
                <span
                  className={
                    jetbrains?.installed && jetbrains?.pluginInstalled
                      ? "inline-flex rounded-[22%] bg-primary p-[2px] shadow-sm shadow-primary/40"
                      : "inline-flex rounded-[22%] bg-muted-foreground/30 p-[2px]"
                  }
                >
                  <JetbrainsMark size={28} />
                </span>
                <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg ring-1 ring-black/5 group-hover:block">
                  JetBrains IDE 插件：{!jetbrains?.installed ? "未检测到 JetBrains IDE" : !jetbrains.pluginInstalled ? "未安装插件" : jetbrains.running ? "运行中" : "已接入"} · 当前账号：{jetbrainsCurrentName}
                </span>
              </span>
            )}
{enabledTools.codebuddyCli && (
              <span className="group relative inline-flex cursor-default">
                <span
                  className={
                    codebuddyCli?.configured
                      ? "inline-flex rounded-[22%] bg-primary p-[2px] shadow-sm shadow-primary/40"
                      : "inline-flex rounded-[22%] bg-muted-foreground/30 p-[2px]"
                  }
                >
                  <CodeBuddyMark size={28} />
                </span>
                <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg ring-1 ring-black/5 group-hover:block">
                  CodeBuddy CLI：{codebuddyCli?.migrationRequired ? "需升级" : codebuddyCli?.configured ? "已接入" : "未接入"} · 当前账号：{codebuddyCurrentName}
                </span>
              </span>
            )}
            </div>
          </div>
        </div>
      </header>

      <div className="relative mb-6 overflow-visible rounded-2xl border border-border bg-muted/30 px-5 py-5 shadow-[0_6px_20px_rgba(15,23,42,.025)]">
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
          <div className="absolute -right-12 -top-20 size-44 rounded-full border-[28px] border-slate-400/[0.035]" />
        </div>
        <div className="relative flex flex-wrap items-center gap-x-5 gap-y-4">
          <div className="min-w-[190px] flex-1">
            <h2 className="text-sm font-semibold text-foreground">添加与迁移账号</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {variant === "ai"
                ? "快速接入国际版账号，或从已有环境恢复"
                : "快速接入新账号，或从已有环境恢复"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <DemoAction>
              <Button
                className="h-10 bg-primary px-4 text-primary-foreground shadow-sm hover:bg-primary/90"
                onClick={() => setOauthOpen(true)}
              >
                {variant === "ai" ? <ExternalLink /> : <QrCode />}
                {variant === "ai" ? "OAuth 登录" : "OAuth 扫码添加"}
              </Button>
            </DemoAction>
          </div>
          <div className="flex items-center gap-1">
            <DemoAction>
              <Button variant="ghost" size="sm" className="h-9 px-2.5" onClick={() => setImportOpen(true)} title="从备份文件导入账号">
                <FileUp />导入备份
              </Button>
            </DemoAction>
            <DemoAction>
              <Button variant="ghost" size="sm" className="h-9 px-2.5" onClick={() => setExportOpen(true)} disabled={visibleAccounts.length === 0} title="导出账号备份">
                <FileDown />导出
              </Button>
            </DemoAction>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {enabledTools.codebuddyCli &&
        codebuddyCli &&
        (!codebuddyCli.configured ||
          (!codebuddyUsesSettingsEnv && !codebuddyCli.helperSupportsAccountIds) ||
          codebuddyCli.migrationRequired ||
          codebuddyCli.syncPending ||
          codebuddyCli.syncInProgress) && (
        <Alert className="mb-4">
          <Terminal />
          <AlertTitle>CodeBuddy CLI 接入</AlertTitle>
          <AlertDescription>
            <p>
              {codebuddyUsesSettingsEnv
                ? codebuddyCli.environmentOverride
                  ? "检测到进程环境变量 CODEBUDDY_AUTH_TOKEN。它会覆盖 settings.json；请先从 Windows 用户或系统环境变量中删除它，再重启本应用与 CodeBuddy CLI。"
                  : codebuddyCli.syncPending
                    ? "Windows CLI 认证配置与当前账号 Token 已脱节。点击更新认证后写入最新 Token；当前运行会话不会切换，请由 ACP 重新加载会话或重启 CLI 后生效。"
                    : codebuddyCli.syncInProgress
                      ? "保活刷新已更新账号 Token，正在同步到 CodeBuddy CLI 认证配置。稍候会自动完成，无需操作。"
                      : codebuddyCli.migrationRequired
                        ? "检测到旧版 Windows helper 配置。接入后会改用 settings.json 的 env.CODEBUDDY_AUTH_TOKEN，不再执行 helper。"
                        : "Windows 使用 CodeBuddy settings.json 中的认证 Token。保活刷新只更新后续启动使用的 Token；切换账号会先关闭正在运行的 CodeBuddy CLI，重新打开 CLI 后即用新账号。"
                : codebuddyCli.migrationRequired
                  ? "检测到旧版 helper，请先升级；升级前不会将 CLI 切换显示为已验证。"
                  : codebuddyCli.configured
                    ? "当前 helper 仍按旧索引读取账号；升级后将按账号 ID 独立切换，账号增删也不会错位。"
                    : "WorkBuddy 账号与积分功能可正常使用；如需从这里切换 CodeBuddy CLI 账号，点击下方按钮一键接入。"}
            </p>
            {/* 同步进行中是正常的中间态：给状态说明但不逼用户点按钮，
                否则用户会在刷新未完成时重复触发写入。 */}
            {!codebuddyCli.syncInProgress && (
              <DemoAction>
                <Button
                  className="mt-2"
                  size="sm"
                  variant="outline"
                  onClick={() => void onInstallCodebuddyCli()}
                  disabled={installingCodebuddyCli}
                >
                  {installingCodebuddyCli && <Loader2 className="animate-spin" />}
                  {codebuddyUsesSettingsEnv
                    ? codebuddyCli.configured ? "更新 CLI 认证" : "接入 CLI"
                    : codebuddyCli.configured || codebuddyCli.migrationRequired ? "升级 CLI helper" : "接入 CLI"}
                </Button>
              </DemoAction>
            )}
          </AlertDescription>
        </Alert>
      )}
      <section className="mt-7 min-w-0" aria-labelledby="accounts-list-title">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 id="accounts-list-title" className="text-base font-semibold tracking-tight">账号</h2>
            <Badge
              variant="secondary"
              className="h-6 min-w-6 rounded-full border-0 px-1.5 text-[11px] tabular-nums text-muted-foreground shadow-none"
              aria-label={`${visibleAccounts.length} 个${variantLabel(variant)}账号`}
            >
              {visibleAccounts.length}
            </Badge>
          </div>
          <TooltipProvider delayDuration={400}>
            <div className="ml-auto flex items-center gap-1">
              {checkinAvailable && autoCheckinConfig && (
                <div className="flex h-9 items-center gap-2 px-2 text-xs text-muted-foreground">
                  <span>自动签到</span>
                  <DemoAction>
                    <Switch
                      checked={autoCheckinEnabled}
                      disabled={autoCheckinSaving}
                      onCheckedChange={(enabled) => void onToggleAutoCheckin(enabled)}
                      aria-label="启用自动签到"
                    />
                  </DemoAction>
                </div>
              )}
              {travelAvailable && autoTravelConfig && (
                <div className="flex h-9 items-center gap-2 px-2 text-xs text-muted-foreground">
                  <span>自动旅行</span>
                  <DemoAction>
                    <Switch
                      checked={autoTravelConfig.enabled}
                      disabled={autoTravelSaving}
                      onCheckedChange={(enabled) => void onToggleAutoTravel(enabled)}
                      aria-label="启用自动旅行"
                    />
                  </DemoAction>
                </div>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("size-9 rounded-lg", compact && "bg-accent text-accent-foreground")}
                    onClick={toggleCompact}
                    aria-label={compact ? "切换为宽松模式" : "切换为紧凑模式"}
                  >
                    {compact ? <Rows3 /> : <Columns3 />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{compact ? "切换为宽松模式" : "切换为紧凑模式"}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <DemoAction>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-9 rounded-lg"
                        disabled={refreshingCredits || checkinAllRunning || visibleAccounts.length === 0}
                        onClick={() => void onRefreshCredits()}
                        aria-label={refreshCreditsLabel}
                      >
                        <RefreshCw className={refreshingCredits || checkinAllRunning ? "animate-spin" : undefined} />
                      </Button>
                    </DemoAction>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">{api.isDemoMode() ? "演示模式下不可操作" : refreshCreditsLabel}</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>
        {loading && visibleAccounts.length === 0 ? (
          <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="animate-spin" />
            加载账号…
          </div>
        ) : visibleAccounts.length === 0 ? (
          <div className="rounded-xl border border-dashed px-4 py-16 text-center text-sm text-muted-foreground">
            {variant === "ai" ? (
              <>
                <p>暂无国际版账号。</p>
                <p className="mt-2 text-xs leading-5">
                  点击上方「OAuth 登录」添加账号；本机已登录的账号也请一并添加，以便随时切回。
                  切换前请确认本机已安装 {appName}（客户端下载域名 {variantDownloadDomain(variant)}）。
                </p>
              </>
            ) : (
              "暂无账号。点击上方「OAuth 扫码添加」接入账号；本机已登录的账号也请一并添加，以便随时切回。"
            )}
          </div>
        ) : (
          <div className={cn("grid min-w-0 gap-5", compact ? "grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))]" : "grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))]")}>
            {/* 不要给这个网格加 items-start：它会覆盖 Grid 默认的 stretch，让同排卡片因内容长度不同而
                高低参差。卡片内部 article 是 flex-col、内容区是 flex-1，会自动吸收差额、footer 自动贴底对齐。 */}
            {orderedAccounts.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                compact={compact}
                onDelete={onDelete}
                onSwitch={setSwitchAccount}
                onShowInfo={setInfoTarget}
                onCleanupSessions={setCleanupSessionsAccount}
                onDedupSessions={setDedupSessionsAccount}
                onCheckin={checkinAvailable ? onCheckin : undefined}
                onRefresh={onRefresh}
                todayCheckedIn={checkinMap[a.id]}
                autoCheckinAllowed={checkinAvailable && autoCheckinSettled ? !excludedCheckinIds.has(a.id) : undefined}
                travelStatus={autoTravelEnabled ? travelMap[a.id] : undefined}
                rateLimits={rateLimitEnabled ? rateLimitMap[a.id] : undefined}
                credit={creditMap[a.id]}
                creditLoading={creditLoadingMap[a.id]}
                creditUpdatedAt={creditUpdatedAtMap[a.id]}
                creditPriority={a.id === priorityAccountId}
                workbuddyActive={enabledTools.workbuddy && isWorkbuddyCurrent(a, current)}
                codebuddyCliConfigured={codebuddyCli?.configured && !codebuddyCli.migrationRequired && !codebuddyCli.syncPending && !codebuddyCli.syncInProgress}
                codebuddyCliActive={enabledTools.codebuddyCli && a.id === cliCurrentAccountId}
                codebuddyCliBusy={codebuddyCliSwitchingId !== null}
                onSwitchCodebuddyCli={onSwitchCodebuddyCli}
                codebuddyCliLoading={codebuddyCliSwitchingId === a.id}
                codebuddyCnIdeAvailable={Boolean(codebuddyCnIde?.installed)}
                codebuddyCnIdeActive={enabledTools.codebuddyIde && a.id === cnIdeCurrentAccountId}
                codebuddyCnIdeBusy={codebuddyIdeSwitchAccount !== null}
                onSwitchCodebuddyCnIde={onSwitchCodebuddyCnIde}
                vscodeExtInstalled={Boolean(vscodeExt?.installed)}
                vscodeExtExtensionInstalled={Boolean(vscodeExt?.extensionInstalled)}
                vscodeExtAvailable={Boolean(vscodeExt?.installed && vscodeExt?.extensionInstalled)}
                vscodeExtActive={enabledTools.vscodeExt && a.id === vscodeExtCurrentAccountId}
                vscodeExtBusy={vscodeSwitchAccount !== null}
                onSwitchVscodeExt={setVscodeSwitchAccount}
                jetbrainsInstalled={Boolean(jetbrains?.installed)}
                jetbrainsPluginInstalled={Boolean(jetbrains?.pluginInstalled)}
                jetbrainsAvailable={Boolean(jetbrains?.installed && jetbrains?.pluginInstalled)}
                jetbrainsActive={enabledTools.jetbrains && a.id === jetbrainsCurrentAccountId}
                jetbrainsBusy={jetbrainsSwitchTarget !== null}
                onSwitchJetbrains={setJetbrainsSwitchTarget}
                enabledTools={enabledTools}
                featuresDisabled={false}
              />
            ))}
          </div>
        )}
      </section>

      <OAuthLoginDialog open={oauthOpen} onOpenChange={setOauthOpen} variant={variant} />
      <ExportAccountsDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        accounts={visibleAccounts}
        onExported={onExported}
      />
      <ImportAccountsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={onImported}
        variant={variant}
      />
      <CleanupSessionsDialog
        open={cleanupSessionsAccount !== null}
        onOpenChange={(open) => {
          if (!open) setCleanupSessionsAccount(null);
        }}
        account={cleanupSessionsAccount}
        onCleaned={() => void fetchAll()}
      />
      <DedupSessionsDialog
        open={dedupSessionsAccount !== null}
        onOpenChange={(open) => {
          if (!open) setDedupSessionsAccount(null);
        }}
        account={dedupSessionsAccount}
        onCleaned={() => void fetchAll()}
      />
      <SwitchAccountDialog
        open={switchAccount !== null}
        onOpenChange={(o) => {
          if (!o) setSwitchAccount(null);
        }}
        account={switchAccount}
        onDone={() => {
          void fetchAll();
          void ensureAppStatus(variant, { force: true });
        }}
      />
      <AccountInfoDialog
        open={infoTarget !== null}
        onOpenChange={(o) => {
          if (!o) setInfoTarget(null);
        }}
        account={infoTarget}
        onSaved={() => {
          void fetchAll();
        }}
      />
      <CodebuddyIdeSwitchAccountDialog
        open={codebuddyIdeSwitchAccount !== null}
        onOpenChange={(o) => {
          if (!o) setCodebuddyIdeSwitchAccount(null);
        }}
        account={codebuddyIdeSwitchAccount}
        variant={variant}
        ideStatus={codebuddyCnIde}
        onDone={() => {
          void ensureAppStatus(variant, { force: true });
        }}
      />
      <VscodeSwitchAccountDialog
        open={vscodeSwitchAccount !== null}
        onOpenChange={(o) => {
          if (!o) setVscodeSwitchAccount(null);
        }}
        account={vscodeSwitchAccount}
        vscodeExtStatus={vscodeExt}
        onDone={() => {
          void ensureAppStatus(variant, { force: true });
        }}
      />
      <JetbrainsSwitchDialog
        open={jetbrainsSwitchTarget !== null}
        onOpenChange={(o) => {
          if (!o) setJetbrainsSwitchTarget(null);
        }}
        account={jetbrainsSwitchTarget}
        jetbrainsStatus={jetbrains}
        onDone={() => {
          void refreshJetbrainsStatus();
        }}
      />

      {/* 接入/升级 CLI 认证确认（桌面 App 不支持 window.confirm） */}
      <Dialog open={installConfirmOpen} onOpenChange={setInstallConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {codebuddyUsesSettingsEnv
                ? "更新 CodeBuddy CLI 认证"
                : codebuddyCli?.configured || codebuddyCli?.migrationRequired
                  ? "升级 CodeBuddy CLI helper"
                  : "接入 CodeBuddy CLI"}
            </DialogTitle>
            <DialogDescription>
              {codebuddyUsesSettingsEnv ? (
                <>
                  将把当前账号的认证 Token 写入
                  <code className="mx-1 rounded bg-muted px-1">~/.codebuddy/settings.json</code>
                  的 <code className="mx-1 rounded bg-muted px-1">env.CODEBUDDY_AUTH_TOKEN</code>。
                  其他配置会保留；更新只影响后续加载的会话，当前运行会话不会切换。是否继续？
                </>
              ) : (
                <>
                  {codebuddyCli?.configured || codebuddyCli?.migrationRequired ? "升级" : "接入"}会自动写入
                  <code className="mx-1 rounded bg-muted px-1">~/.codebuddy-rotate/helper.cjs</code>
                  并更新
                  <code className="mx-1 rounded bg-muted px-1">~/.codebuddy/settings.json</code>
                  的 apiKeyHelper 配置，是否继续？
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInstallConfirmOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void confirmInstallCodebuddyCli()}>继续</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 切换 CodeBuddy CLI 确认（桌面 App 不支持 window.confirm） */}
      <Dialog open={cliSwitchTarget !== null} onOpenChange={(open) => !open && setCliSwitchTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>切换 CodeBuddy CLI</DialogTitle>
            <DialogDescription>
              将把 CodeBuddy CLI 默认账号设为「{cliSwitchAccountLabel}」。
              确认后会关闭正在运行的 CodeBuddy CLI 会话，当前会话会中断；重新打开 CLI 后新账号才会生效。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCliSwitchTarget(null)}>
              取消
            </Button>
            <Button onClick={() => void confirmSwitchCodebuddyCli()}>
              关闭 CLI 并切换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除账号确认 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除账号</DialogTitle>
            <DialogDescription>
              确定删除账号「{deleteTarget ? displayName(deleteTarget) : ""}」？
              此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
