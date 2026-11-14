# lingxi.exe（app-server 6.1.0 / build 155）stdio JSON-RPC 协议笔记

> 2026-11-13 逆向记录。来源：客户端运行时日志（`logs/app/app.*.log` 的
> `request_sent`/`request_completed` 事件、`logs/app-server/*.log`）+ 二进制字符串池
> + 实测。vendor exe 与客户端 exe sha256 相同（`9145ba7c9ebaeb3d…`）。

## 启动参数

```
lingxi.exe --stdin --auth-storage runtime --config <config.json> --data-dir <state-dir>
```

- `--auth-storage runtime`：凭据不落盘，由 RPC 注入。**必须用这个**；
  `--auth-file` 模式（auth.json 承载 wps_sid）会在启动阶段
  `resolve cloud account identity` 即失败（该模式服务端校验更严/不同）。
- `--config`：客户端的 config.json 可直接复用（sandbox 路径等）。
- `--data-dir`：本地状态目录，会自动建 `accounts/<uid>/` 等。

## JSON-RPC 方法表（从二进制 + 客户端日志提取）

```
account/{login/start, status, logout, install, uninstall, profile, api_access_management}
session/{start, list, messages, subscribe, unsubscribe, read, pin, delete,
         title_updated, messages_convert, credentials, env_config, custom_transport}
run/{start, interrupt, steer}
sandbox/account/{status, install, uninstall}
config/{read, write}
gateway/{asr, chat_completion, embedding, image_*, tts, web_search, response_*}
```

## 握手序列（已实测打通 ✅）

```jsonc
// 1. initialize —— protocol_version 必须是 "2026-08-13"，否则 -32602
{"jsonrpc":"2.0","id":"s:1","method":"initialize","params":{
  "protocol_version":"2026-08-13",
  "client_info":{"name":"lingxi-desktop","version":"1.3.41"},
  "capabilities":{}
}}
// → result: {protocol_version:"2026-08-13", server_info:{name:"lingxi-app-server",version:"155",...},
//            capabilities:{bash_approval,skill_management,timer_task,session_persistence,
//                          connectors,session_subscribe,supported_api_formats:[chat_completions,responses,anthropic],run_steer}}

// 2. initialized 通知
{"jsonrpc":"2.0","method":"initialized"}

// 3. 登录（wps_sid 是扁平字符串，不是 {value:...} 对象）
{"jsonrpc":"2.0","id":"s:2","method":"account/login/start","params":{
  "auth_mode":"wps_sid","wps_sid":"V02…"
}}
// → result: {logged_in:true, auth_mode:"wps_sid", source:"runtime"}
// → 通知: {"jsonrpc":"2.0","method":"account/updated","params":{auth_mode,create_time,logged_in:true,source:"runtime"}}
// ⚠️ login/start 的服务端校验比 HTTP 平面严：sid 轮换后 RPC 401 UserUnauthorized(401020001)
//    但同一 sid 打 HTTP account/profile 仍 200。要用新鲜登录的 sid。
// ⚠️ account/updated 通知到达之前发 session/start 会回
//    Unavailable(50002) detail.account_readiness="binding" —— 必须等登录广播。

// 4. 建会话（已实测打通 ✅）
{"jsonrpc":"2.0","id":"c:3","method":"session/start","params":{
  "session_type":"cowork_client","agent_version":2
}}
// → result: {session_id:"1213…", session_type:"cowork_client", agent:"lingxiclaw",
//            client_type:"local_tui", title:"新任务", language:"zh", created_at, updated_at}

// 5. run/start —— ⚠️ 未打通：全部形状回 InvalidArgument(400000007)
// 结构（二进制确认）：
//   { session_id: string, compact: bool, agent_input: RawMessage,
//     model: core.ModelRef, trace_id: string }
// agent_input 解码报 "decode agent_input: %w"；已试形状：
//   agent_input:{text} / {text,expect_model} / HTTP credits/runs 的完整 agent_input
//   model:{provider,id}|{provider,model}|{name}|字符串 —— 全部 InvalidArgument。
// 缺口：agent_input 的内部 schema 与 ModelRef 字段名。待抓客户端真实请求
// （客户端日志 request_sent 事件会明文记录全部参数）。
```

## id 格式

客户端用 `"s:desktop_N"` 前缀格式（`s:desktop_1`、`s:desktop_8`…），任意字符串 id 均可。

## 凭据来源

- 客户端 `--auth-storage runtime`：主进程把浏览器 Cookie 里的 wps_sid 通过
  `account/login/start` 注入，auth.json 落盘但 value 为空。
- 抓新鲜 sid 的可行路径：插件的 `chromiumLogin`（隔离 Chrome profile 打开
  lingxi.wps.cn，CDP `Network.getAllCookies` 读 `wps_sid`）。
- 客户端本地 Cookie 库（`Partitions/*/Network/Cookies`）运行中被锁，
  `importLocalAccount` 读不到（客户端在跑时）；auth-snapshot.json 是 DPAPI 加密。

## 关键日志位置

- 主进程 RPC 明文：`C:\Users\admin\AppData\Roaming\WPS 灵犀\logs\app\app.*.log`
  （`module":"app-server:transport"`，`request_sent` / `request_completed` /
  `notification_received`，params/result 明文，sid 打码为 `[REDACTED]`）。
- exe 自身日志：`logs\app-server\app-server_*.log`（logrus 格式，
  `initialize completed protocol_version=…` 在这里）。
- 客户端版本 1.3.41，app-server 6.1.0（version=155，commit 6ebae1ae，
  built 2026-11-13T12:18:50+08:00）。
