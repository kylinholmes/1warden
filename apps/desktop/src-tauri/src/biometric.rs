//! Touch ID 解锁 —— **spec 不变量 S1 的唯一显式例外**。
//!
//! ## S1 说的是什么，以及为什么这里必须破例
//!
//! 会话状态机的约定是：内存里的密钥与明文**永不落盘**。指纹解锁**必然**
//! 要持久化点什么 —— 否则重启之后没有任何东西能解开保险库，指纹也就无从谈起。
//!
//! 所以这不是「悄悄放宽了 S1」，而是一个**用户显式开启**的例外：
//!
//!   · 默认关闭，不开就完全不存在（钥匙串里连条目都没有）
//!   · 存的是**解锁材料**（用户密钥 / 账户 / 刷新令牌），不是明文保险库
//!   · 存在**系统钥匙串**里，由 `kSecAccessControlBiometryCurrentSet` 把住，
//!     不是普通文件
//!   · 关掉就立即删除
//!
//! ## 为什么整段都是裸 FFI
//!
//! ⚠️ `security-framework` 的高层 `ItemAddOptions` **没有** `kSecAttrAccessControl`
//! 字段。用它写出来的东西**编译得过、跑得起来、功能看着正常** ——
//! 但存进去的是一个任何进程都能读的普通钥匙串条目，**生物识别绑定根本不存在**。
//! 这种「看起来对」的错误比编译错误危险得多。
//!
//! 拼字典那一层则是因为 `core-foundation` 0.10 的包装**不实现 `Drop`** ——
//! 用它等于每次调用漏一个 CF 对象。裸 FFI 啰嗦，但每个引用的归属写明白了。
//!
//! ## ⚠️ 这个功能**需要代码签名**，当前构建方式下跑不起来
//!
//! 带 `kSecAttrAccessControl` 写钥匙串走的是**数据保护钥匙串**，而它要求进程
//! 带着 `keychain-access-groups` 权限 —— 那来自一份 provisioning profile。
//!
//! 实测（三步，都跑过）：
//!
//! ```text
//! 不带 ACL 写钥匙串              → 0        成功
//! 带   ACL 写钥匙串（裸二进制）  → -34018   errSecMissingEntitlement
//! 带   ACL + adhoc 签名挂权限    → 被 SIGKILL（退出码 137）
//! ```
//!
//! 第三条尤其说明问题：`keychain-access-groups` 是**受限权限**，
//! 手工挂上去的 adhoc 签名在内核层就被判无效，进程起不来 —— 伪造不过去。
//!
//! 而 `tauri dev` 跑出来的二进制是 `adhoc, linker-signed`、没有 TeamIdentifier。
//! **所以这不是「还没写完」，是「当前构建方式下不可能工作」。**
//!
//! 要让它真的能用，需要：
//!   1. 一个 Apple 开发者账号（个人账号即可）
//!   2. 一份带 `keychain-access-groups` 的 provisioning profile
//!   3. 构建时用它签名（`tauri build` 的 signingIdentity 配置）
//!
//! 在那之前**不要**给界面加上那个开关 —— 一个永远失败的开关比没有更糟。
//!
//! ## `.biometryCurrentSet` 而不是 `.userPresence`
//!
//! 前者在**指纹集合变化时作废**这条记录（新增或删除一枚指纹都会）。
//! 这是想要的：指纹变了说明设备可能易主。代价是用户要去设置里重新开启一次，
//! 而这件事**必须说清楚**，否则表现是「指纹突然解不开了」而用户不知道为什么。

use core_foundation_sys::base::{kCFAllocatorDefault, CFIndex, CFRelease, CFTypeRef};
use core_foundation_sys::data::{CFDataCreate, CFDataGetBytePtr, CFDataGetLength, CFDataRef};
use core_foundation_sys::error::CFErrorRef;
use core_foundation_sys::dictionary::{
    kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks, CFDictionaryCreate,
    CFDictionaryRef,
};
use core_foundation_sys::number::kCFBooleanTrue;
use core_foundation_sys::string::{kCFStringEncodingUTF8, CFStringCreateWithBytes};
use serde::Serialize;
use security_framework_sys::access_control::{
    kSecAccessControlBiometryCurrentSet, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
    SecAccessControlCreateWithFlags,
};
use security_framework_sys::base::{errSecItemNotFound, errSecSuccess, SecAccessControlRef};
use security_framework_sys::item::{
    kSecAttrAccessControl, kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword,
    kSecReturnData, kSecUseAuthenticationUI, kSecUseAuthenticationUISkip,
    kSecValueData,
};
use security_framework_sys::keychain_item::{SecItemAdd, SecItemCopyMatching, SecItemDelete};
use std::ffi::c_void;

/// 钥匙串里的服务名。换个名字就等于换一条记录，旧的自然失效
const SERVICE: &str = "app.onewarden.desktop.biometric";
const ACCOUNT: &str = "vault-unlock";

/// `errSecInteractionNotAllowed`：条目在，但需要认证才能取。
/// `security-framework-sys` 没导出这个常量，值取自 Security 框架的 `SecBase.h`
const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;
/// `errSecUserCanceled`：用户在指纹弹窗上点了取消
const ERR_SEC_USER_CANCELED: i32 = -128;
/// `errSecDuplicateItem`：同名条目已存在
const ERR_SEC_DUPLICATE_ITEM: i32 = -25299;

/// 持有一个 +1 的 CF 对象，drop 时释放。
///
/// 手写这个是因为 `core-foundation` 0.10 的包装**不实现 `Drop`** ——
/// 用那套的话每个对象都要调用方记得手动释放，忘一个就漏一个，
/// 而钥匙串调用不频繁，漏了根本看不出来。
struct OwnedCf(*const c_void);

impl OwnedCf {
    fn as_type_ref(&self) -> CFTypeRef {
        self.0 as CFTypeRef
    }
    fn as_dict(&self) -> CFDictionaryRef {
        self.0 as CFDictionaryRef
    }
    fn as_data(&self) -> CFDataRef {
        self.0 as CFDataRef
    }
}

impl Drop for OwnedCf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}

/// 造一个 CFString（+1）。`s` 是 UTF-8。
fn cfstring(s: &str) -> OwnedCf {
    // SAFETY: 指针与长度都来自同一个 &str，编码声明为 UTF-8，
    // `isExternalRepresentation = false`（0）表示这是内部表示
    let ptr = unsafe {
        CFStringCreateWithBytes(
            kCFAllocatorDefault,
            s.as_ptr(),
            s.len() as CFIndex,
            kCFStringEncodingUTF8,
            0,
        )
    };
    OwnedCf(ptr as *const c_void)
}

/// 造一个 CFData（+1）
fn cfdata(bytes: &[u8]) -> OwnedCf {
    // SAFETY: 指针与长度来自同一个切片，CFDataCreate 会**拷贝**内容
    let ptr = unsafe {
        CFDataCreate(kCFAllocatorDefault, bytes.as_ptr(), bytes.len() as CFIndex)
    };
    OwnedCf(ptr as *const c_void)
}

/// 造一个 CFDictionary（+1）。
///
/// 用 `kCFType*CallBacks`：字典会 **retain** 键和值，所以传进来的那些
/// 引用在调用返回后就可以释放 —— 归属是清楚的。
fn cfdict(pairs: &[(*const c_void, *const c_void)]) -> OwnedCf {
    let keys: Vec<*const c_void> = pairs.iter().map(|(k, _)| *k).collect();
    let values: Vec<*const c_void> = pairs.iter().map(|(_, v)| *v).collect();
    // SAFETY: 两个数组与 pairs 等长且一一对应；callbacks 是框架提供的静态量
    let ptr = unsafe {
        CFDictionaryCreate(
            kCFAllocatorDefault,
            keys.as_ptr(),
            values.as_ptr(),
            pairs.len() as CFIndex,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
    };
    OwnedCf(ptr as *const c_void)
}

/// 造基础查询字典，并在返回前释放临时对象。返回 +1 的字典。
///
/// 服务名可传，是为了让测试用**另一条**记录 —— 否则跑一次测试就会
/// 把用户真实的指纹解锁配置删掉，而那是他手动开启的。
fn base_dict_for(service_name: &str, extra: Vec<(*const c_void, *const c_void)>) -> OwnedCf {
    let service = cfstring(service_name);
    let account = cfstring(ACCOUNT);
    let mut pairs: Vec<(*const c_void, *const c_void)> = vec![
        (unsafe { kSecClass as *const c_void }, unsafe {
            kSecClassGenericPassword as *const c_void
        }),
        (unsafe { kSecAttrService as *const c_void }, service.as_type_ref()),
        (unsafe { kSecAttrAccount as *const c_void }, account.as_type_ref()),
    ];
    pairs.extend(extra);
    // 字典会 retain 键值，所以这里可以放心释放
    let dict = cfdict(&pairs);
    drop(service);
    drop(account);
    dict
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiometricStatus {
    /// 这台机器有没有可用的生物识别。
    ///
    /// ⚠️ 这里只说明**平台支持**（编译期是 macOS）。真要确认有没有录入指纹，
    /// 得调 `LAContext`，而那是 Objective-C 运行时调用（`objc_msgSend`
    /// 要按签名 transmute），为这一个布尔值不值得。真正的答案在
    /// `biometric_enroll` 那一步给 —— 那里 Apple 会把确切原因报出来。
    pub supported: bool,
    /// 是不是已经开启过（钥匙串里有那条记录）
    pub enrolled: bool,
}

/// 钥匙串里有没有那条记录 —— **不弹指纹**。
///
/// 用 `kSecUseAuthenticationUISkip` 让查询在需要认证时直接返回而不是弹窗：
/// 条目存在 → `errSecInteractionNotAllowed`；不存在 → `errSecItemNotFound`。
/// 这样设置界面能显示开关状态，而用户不会一进设置就被弹一次指纹。
fn base_dict(extra: Vec<(*const c_void, *const c_void)>) -> OwnedCf {
    base_dict_for(SERVICE, extra)
}

fn item_exists_for(service_name: &str) -> bool {
    let query = base_dict_for(service_name, vec![(
        unsafe { kSecUseAuthenticationUI as *const c_void },
        unsafe { kSecUseAuthenticationUISkip as *const c_void },
    )]);
    let status = unsafe { SecItemCopyMatching(query.as_dict(), std::ptr::null_mut()) };
    status == ERR_SEC_INTERACTION_NOT_ALLOWED || status == errSecSuccess
}

fn item_exists() -> bool {
    // ⚠️ `kSecUseAuthenticationUISkip` 是框架里的**静态对象**，
    // 绝不能包进 `OwnedCf` —— 那会在 drop 时 CFRelease 一个不属于我们的对象。
    // 静态量直接把裸指针交给字典（字典用 get 规则读它，不会夺走所有权）。
    let query = base_dict(vec![(
        unsafe { kSecUseAuthenticationUI as *const c_void },
        unsafe { kSecUseAuthenticationUISkip as *const c_void },
    )]);
    let status = unsafe { SecItemCopyMatching(query.as_dict(), std::ptr::null_mut()) };
    status == ERR_SEC_INTERACTION_NOT_ALLOWED || status == errSecSuccess
}

#[tauri::command]
pub fn biometric_status() -> BiometricStatus {
    BiometricStatus { supported: cfg!(target_os = "macos"), enrolled: item_exists() }
}

/// 建一个「只有当前这组指纹能解」的访问控制对象（+1）
fn make_access_control() -> Result<OwnedCf, String> {
    // 参数本身就是 `*mut CFErrorRef`（也就是 `*mut *mut __CFError`），
    // 所以这里只要一个 CFErrorRef，传 `&mut` 正好
    let mut error: CFErrorRef = std::ptr::null_mut();
    let access: SecAccessControlRef = unsafe {
        SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            // `WhenPasscodeSetThisDeviceOnly`：设备没设密码时这条**不存在**，
            // 而且不参与 iCloud 钥匙串同步 —— 凭据不该离开这台设备
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly as CFTypeRef,
            kSecAccessControlBiometryCurrentSet,
            &mut error,
        )
    };
    if access.is_null() {
        return Err("这台设备用不了 Touch ID（没有录入指纹，或者没设开机密码）".into());
    }
    Ok(OwnedCf(access as *const c_void))
}

/// 把解锁材料存进钥匙串，用指纹把住。
///
/// `secret` 是 `@1warden/vault` 那边的一份**精简**快照（用户密钥、账户信息、
/// 刷新令牌）—— 不含明文条目，那些解锁后同步回来。
#[tauri::command]
pub fn biometric_enroll(secret: String) -> Result<(), String> {
    enroll_for(SERVICE, &secret)
}

fn enroll_for(service_name: &str, secret: &str) -> Result<(), String> {
    // 「重新开启」是正常操作，而钥匙串的 add 遇到同名条目会返回
    // errSecDuplicateItem —— 所以先删掉旧的
    forget_for(service_name)?;

    let access = make_access_control()?;
    let data = cfdata(secret.as_bytes());

    let query = base_dict_for(service_name, vec![
        (unsafe { kSecValueData as *const c_void }, data.as_type_ref()),
        (unsafe { kSecAttrAccessControl as *const c_void }, access.as_type_ref()),
    ]);

    let status = unsafe { SecItemAdd(query.as_dict(), std::ptr::null_mut()) };
    match status {
        errSecSuccess => Ok(()),
        ERR_SEC_DUPLICATE_ITEM => Err("钥匙串里已经有这条记录了".into()),
        other => Err(format!("写入钥匙串失败（错误码 {other}）")),
    }
}

/// 取出解锁材料 —— **这一步会弹指纹**。
#[tauri::command]
pub fn biometric_unlock() -> Result<String, String> {
    let query = base_dict(vec![(
        unsafe { kSecReturnData as *const c_void },
        // `kCFBooleanTrue` 是框架里的静态对象，不需要释放
        unsafe { kCFBooleanTrue as *const c_void },
    )]);

    let mut result: CFTypeRef = std::ptr::null();
    let status = unsafe { SecItemCopyMatching(query.as_dict(), &mut result) };

    match status {
        errSecSuccess => {}
        errSecItemNotFound => return Err("指纹解锁没有开启".into()),
        ERR_SEC_USER_CANCELED => return Err("已取消".into()),
        // 指纹集合变了（加了或删了一枚指纹）会让 `.biometryCurrentSet` 记录作废
        other => {
            return Err(format!(
                "无法读取指纹记录（错误码 {other}），请用主密码解锁后重新开启"
            ))
        }
    }
    if result.is_null() {
        return Err("钥匙串返回了空数据".into());
    }

    // CopyMatching 按 create 规则返回（+1），交给 OwnedCf 释放
    let owned = OwnedCf(result as *const c_void);
    let data = owned.as_data();
    // SAFETY: 上一步已确认非空；CopyMatching 返回的就是 CFData
    let bytes = unsafe {
        let ptr = CFDataGetBytePtr(data);
        let len = CFDataGetLength(data);
        if ptr.is_null() || len <= 0 {
            return Err("钥匙串里的内容是空的".into());
        }
        std::slice::from_raw_parts(ptr, len as usize).to_vec()
    };

    String::from_utf8(bytes).map_err(|_| "钥匙串里的内容不是合法的 UTF-8".to_string())
}

/// 关掉指纹解锁 —— 立即删除。
#[tauri::command]
pub fn biometric_forget() -> Result<(), String> {
    forget_for(SERVICE)
}

fn forget_for(service_name: &str) -> Result<(), String> {
    let query = base_dict_for(service_name, Vec::new());
    let status = unsafe { SecItemDelete(query.as_dict()) };
    match status {
        errSecSuccess | errSecItemNotFound => Ok(()),
        other => Err(format!("删除钥匙串记录失败（错误码 {other}）")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ⚠️ 测试用**另一个**服务名。
    ///
    /// 跑测试绝不能动到用户真实的指纹解锁配置 —— 那是他手动开启的，
    /// 被一次 `cargo test` 悄悄删掉，表现是「指纹突然不能用了」。
    ///
    /// ⚠️ 而且**每个测试各用一条**：cargo 默认并行跑测试，
    /// 共用一个名字的话它们互相清场，表现是随机的「写完查不到」
    /// 或者「删完还在」。这类失败看起来像功能坏了，其实是测试在抢资源。
    fn scratch_service(case: &str) -> String {
        format!("app.onewarden.desktop.biometric.selftest.{case}")
    }

    /// 试着读那条记录，但明确跳过任何认证界面。返回 OSStatus。
    fn read_status_without_auth(service_name: &str) -> i32 {
        let query = base_dict_for(service_name, vec![
            (unsafe { kSecReturnData as *const c_void }, unsafe {
                kCFBooleanTrue as *const c_void
            }),
            (unsafe { kSecUseAuthenticationUI as *const c_void }, unsafe {
                kSecUseAuthenticationUISkip as *const c_void
            }),
        ]);
        unsafe { SecItemCopyMatching(query.as_dict(), std::ptr::null_mut()) }
    }

    /// **基线**：钥匙串的管道本身是通的。
    ///
    /// 这条不带 `kSecAttrAccessControl`，所以走的是老式的文件钥匙串，
    /// 不需要任何权限。它成功说明字典拼得对、属性名没写错 ——
    /// 于是下面那些 `-34018` 才**确实是权限问题**，而不是我的 FFI 写错了。
    ///
    /// ⚠️ 这条不能删。删了之后「带 ACL 写入失败」就没有参照物，
    /// 下一次看到 -34018 的人会先去怀疑代码，而问题在签名。
    #[test]
    fn plain_keychain_write_is_the_control() {
        let TEST_SERVICE = scratch_service("control");
        forget_for(&TEST_SERVICE).expect("清场");
        let data = cfdata(b"plain");
        let query = base_dict_for(&TEST_SERVICE, vec![
            (unsafe { kSecValueData as *const c_void }, data.as_type_ref()),
        ]);
        let status = unsafe { SecItemAdd(query.as_dict(), std::ptr::null_mut()) };
        forget_for(&TEST_SERVICE).expect("收尾");
        assert_eq!(status, errSecSuccess, "不带 ACL 的写入本来就该成功（实际 {status}）");
    }

    /// 没开启时读，应当是「找不到」而不是别的错 ——
    /// 界面靠这个区分「没开启」和「读取失败」
    #[test]
    fn a_missing_item_reports_not_found() {
        let svc = scratch_service("missing");
        forget_for(&svc).expect("清场");
        assert!(!item_exists_for(&svc));
        assert_eq!(read_status_without_auth(&svc), errSecItemNotFound);
    }

    /*
     * ────────────────────────────────────────────────────────────────
     * 下面两条**需要代码签名**，默认不跑。
     *
     * 带着 `kSecAttrAccessControl` 写钥匙串走的是**数据保护钥匙串**，
     * 而它要求进程带着 `keychain-access-groups` 权限 —— 那来自一份
     * provisioning profile，`cargo test` 出来的裸二进制没有。
     *
     * 实测（这就是上面那条基线测试的用处）：
     *
     *     不带 ACL 写入         → 0        成功
     *     带   ACL 写入         → -34018   errSecMissingEntitlement
     *
     * 管道是通的，缺的是权限。所以这两条不是「还没实现」，是
     * **在当前构建方式下跑不了**。
     *
     * 跑它们要：给二进制签上带钥匙串权限的 provisioning profile，
     * 然后 `cargo test -- --ignored`。打包成 .app 并正确签名之后，
     * 同样的代码在真机上应当能过 —— 但**这一点我还没验证过**，
     * 别把它当成已知事实。
     * ────────────────────────────────────────────────────────────────
     */

    /// 钥匙串读写一整圈。**不弹指纹** —— 只有读明文才需要，
    /// 而这里刻意不去读（那需要用户按手指，没法自动化）。
    #[test]
    #[ignore = "需要带钥匙串权限的代码签名，见上方说明"]
    fn round_trips_through_the_keychain() {
        let svc = scratch_service("roundtrip");
        forget_for(&svc).expect("清场");
        assert!(!item_exists_for(&svc), "开始时不该有记录");

        enroll_for(&svc, r#"{"userKey":"base64...","email":"a@b.c"}"#)
            .expect("应当能写入钥匙串");
        assert!(item_exists_for(&svc), "写完应当能查到");

        forget_for(&svc).expect("删除应当成功");
        assert!(!item_exists_for(&svc), "删完不该还在");
    }

    /// ⚠️ **安全断言**：存进去的东西，不做认证读不出来。
    ///
    /// 这是「看起来能用、其实没有生物识别绑定」那个错误的唯一防线。
    /// 挂 ACL 的方式写错（比如用 `security-framework` 的 high-level API ——
    /// 它的 `ItemAddOptions` 根本没有这个字段）时，别的测试照样全绿，
    /// **只有这条会红**。
    #[test]
    #[ignore = "需要带钥匙串权限的代码签名，见上方说明"]
    fn the_secret_cannot_be_read_without_authentication() {
        let svc = scratch_service("unreadable");
        forget_for(&svc).expect("清场");
        enroll_for(&svc, "绝密").expect("写入");

        let status = read_status_without_auth(&svc);
        assert_eq!(
            status, ERR_SEC_INTERACTION_NOT_ALLOWED,
            "不带认证应当读不出来（-25308），实际拿到 {status} —— \
             拿到 0 说明 ACL 没挂上，条目根本不设防"
        );

        forget_for(&svc).expect("收尾");
    }
}
