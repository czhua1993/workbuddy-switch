//! 从官方控制台「账号」接口拉取最新账号资料，同步回本地账号库。
//!
//! 对照 `GET https://www.workbuddy.cn/console/accounts` 返回的 `data.accounts[]`
//! （2026-09-20 用户提供的一手响应）：在「签到 / 刷新全部账号积分」时把可展示字段
//! （uid / nickname / uin / type 等）刷新回账号记录，避免昵称、类型变更后账号列表
//! 仍显示旧值。`/account/info` 是附带动作，任何失败都静默跳过，不影响主流程。

use serde_json::{json, Value};

use crate::modules::account::{
    account_display_name, build_auth_headers, find_account, get_str, upsert_account, variant_of,
};
use crate::modules::config::http_request;
use crate::modules::refresh::ensure_fresh_token;
use crate::modules::variant::WbVariant;

/// 国内版控制台账号接口（实测存在，返回 `data.accounts[]`）。
const CN_CONSOLE_ACCOUNTS_URL: &str = "https://www.workbuddy.cn/console/accounts";
/// 国际版同构接口（路径同形；可用性待确认，缺失时按 skip 处理，不报错）。
const AI_CONSOLE_ACCOUNTS_URL: &str = "https://www.workbuddy.ai/console/accounts";

fn console_accounts_url(account: &Value) -> &'static str {
    match variant_of(account) {
        WbVariant::Cn => CN_CONSOLE_ACCOUNTS_URL,
        WbVariant::Ai => AI_CONSOLE_ACCOUNTS_URL,
    }
}

/// 控制台响应里挑出与本地账号匹配的条目：优先按 uid 精确匹配；
/// uid 缺失时退回到 `lastLogin = true` 标记的当前账号。
fn match_console_account(console: &Value, account: &Value) -> Option<Value> {
    let accounts = console
        .get("data")
        .and_then(|d| d.get("accounts"))
        .and_then(Value::as_array)?;
    if accounts.is_empty() {
        return None;
    }
    if let Some(uid) = get_str(account, "uid").as_deref() {
        if let Some(found) = accounts
            .iter()
            .find(|a| get_str(a, "uid").as_deref() == Some(uid))
        {
            return Some(found.clone());
        }
    }
    // uid 缺失（极少数历史账号）时，落到控制台标记的当前登录账号。
    accounts
        .iter()
        .find(|a| a.get("lastLogin").and_then(Value::as_bool) == Some(true))
        .cloned()
}

/// 把控制台账号条目里的可展示字段合并进本地账号记录（不触碰 token / 档位等字段）。
fn merge_profile(account: &mut Value, entry: &Value) {
    for key in [
        "uid",
        "nickname",
        "uin",
        "type",
        "accountType",
        "lastLogin",
        "phoneNumber",
        "idp",
        "isCreator",
        "isAdmin",
        "pluginEnabled",
    ] {
        if let Some(v) = entry.get(key) {
            account[key] = v.clone();
        }
    }
    account["profile_console_raw"] = entry.clone();
}

/// 取身份相关字段快照，用于判断资料是否发生变化。
fn identity_snapshot(account: &Value) -> Value {
    json!({
        "uid": account.get("uid"),
        "nickname": account.get("nickname"),
        "uin": account.get("uin"),
        "type": account.get("type"),
    })
}

/// 拉取控制台账号列表（GET /console/accounts）。
async fn fetch_console_accounts(account: &Value) -> Value {
    let url = console_accounts_url(account);
    let headers = build_auth_headers(account);
    http_request(url, "GET", None, Some(&headers)).await
}

/// 刷新单个账号的资料：成功返回已落盘的最新账号，失败返回原账号。
async fn refresh_one_account_info(mut account: Value) -> Value {
    // 先保证 token 新鲜，避免 401 直接被判失败；刷新失败时退回原账号重试一次控制台。
    let cfg = crate::modules::config::load_checkin_config();
    let working = ensure_fresh_token(account.clone(), &cfg).await;
    account = if working.get("needs_relogin").and_then(Value::as_bool) == Some(true) {
        account
    } else {
        working
    };

    let resp = fetch_console_accounts(&account).await;
    let code = resp.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        return account;
    }
    let Some(entry) = match_console_account(&resp, &account) else {
        return account;
    };
    merge_profile(&mut account, &entry);
    let _ = upsert_account(&account);
    account
}

/// 批量刷新账号资料（「签到并刷新全部账号积分」的附带动作）。
///
/// 对每个 id 尽力而为：缺账号、接口失败、无匹配都跳过，不影响签到/积分主流程。
/// 返回每个账号的结果，前端据此决定是否 `fetchAll` 强制刷新列表。
pub async fn refresh_account_info(account_ids: &[String]) -> Value {
    let mut results: Vec<Value> = Vec::new();
    let mut updated = 0;
    for id in account_ids {
        let Some(account) = find_account(id) else {
            results.push(json!({ "accountId": id, "status": "missing" }));
            continue;
        };
        let before = identity_snapshot(&account);
        let refreshed = refresh_one_account_info(account).await;
        let after = identity_snapshot(&refreshed);
        let changed = before != after;
        if changed {
            updated += 1;
        }
        results.push(json!({
            "accountId": id,
            "status": "ok",
            "changed": changed,
            "accountName": account_display_name(&refreshed),
        }));
    }
    json!({ "results": results, "updated": updated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn match_prefers_uid_then_last_login() {
        let console = json!({
            "code": 0,
            "data": {
                "accounts": [
                    { "uid": "u-other", "nickname": "别人", "lastLogin": false },
                    { "uid": "u-self", "nickname": "自己", "lastLogin": false },
                    { "uid": "u-current", "nickname": "当前", "lastLogin": true },
                ]
            }
        });
        // 按 uid 命中 u-self
        let acc = json!({ "id": "a", "uid": "u-self", "nickname": "旧" });
        assert_eq!(
            match_console_account(&console, &acc)
                .unwrap()
                .get("uid")
                .and_then(Value::as_str),
            Some("u-self")
        );

        // uid 缺失 → 退回到 lastLogin 标记
        let acc_no_uid = json!({ "id": "a", "nickname": "旧" });
        assert_eq!(
            match_console_account(&console, &acc_no_uid)
                .unwrap()
                .get("uid")
                .and_then(Value::as_str),
            Some("u-current")
        );

        // 无匹配且无 lastLogin → None
        let empty = json!({ "code": 0, "data": { "accounts": [] } });
        assert!(match_console_account(&empty, &acc).is_none());
    }

    #[test]
    fn merge_profile_keeps_tokens_and_variant() {
        let mut account = json!({
            "id": "a",
            "uid": "u-old",
            "nickname": "旧昵称",
            "access_token": "SECRET",
            "variant": "cn",
        });
        let entry = json!({
            "uid": "u-new",
            "nickname": "新昵称",
            "uin": "3301",
            "type": "personal",
            "lastLogin": true,
        });
        merge_profile(&mut account, &entry);
        assert_eq!(account.get("uid").and_then(Value::as_str), Some("u-new"));
        assert_eq!(account.get("nickname").and_then(Value::as_str), Some("新昵称"));
        assert_eq!(account.get("uin").and_then(Value::as_str), Some("3301"));
        assert_eq!(account.get("access_token").and_then(Value::as_str), Some("SECRET"));
        assert_eq!(account.get("variant").and_then(Value::as_str), Some("cn"));
        assert!(account
            .get("profile_console_raw")
            .and_then(Value::as_object)
            .is_some());
    }
}
