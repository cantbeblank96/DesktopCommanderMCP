# Remote Desktop Commander：SSH 节点设备接入技术方案

**版本：** 设计稿 v1.0  
**核查日期：** 2026-09-18  
**目标读者：** 负责 DesktopCommanderMCP 二次开发、部署与测试的工程人员  
**交付状态：** 源码核查后的实现规格；尚未完成补丁开发、编译及真实 A/B/官网端到端验证。

> **核心目标：在机器 A 运行修改后的 Remote Desktop Commander，通过 SSH 启动机器 B 的普通 Desktop Commander 后端，把 B 以独立设备身份加入原有 Devices 列表。ChatGPT 对 B 调用原有文件、终端、进程工具，无需自行执行 SSH。**
>
> 本方案不修改用户的 ChatGPT 个性化设置，不要求替换现有 ChatGPT 应用，也不把“改一个设备显示名”当作功能完成。

---

## 1. 需求、边界与推荐路线

### 1.1 术语

- **A：连接机。** 能访问 Desktop Commander 云端，也能通过 SSH 访问 B。在 A 上运行设备连接进程，保存该逻辑设备的云端登录凭据。
- **B：执行节点。** 实际读写文件、运行命令的服务器节点。已有 SSH 服务；本方案还要求 B 能运行普通的 Desktop Commander MCP 后端。
- **profile：设备配置档。** 一个 profile 对应一个 SSH 目标、一个后台连接、一个设备身份和一份独立状态。
- **后端：** Desktop Commander 实际执行工具的程序，不是官网服务器。

### 1.2 必须实现的用户体验

| 项目 | 完成标准 |
|---|---|
| 独立显示 | 原有 A 设备保留；B 在同一账号的 Devices 中有自己的条目与设备 ID |
| 直接操作 | 选择 B 后，原有 `read_file`、`write_file`、`start_process` 等作用于 B |
| 透明连接 | ChatGPT 不负责建立 SSH，也不需要把每条工具调用改写成 SSH 命令 |
| 独立维护 | 重启 B 的连接进程不改变 A 的身份、不清除 A 的凭据、不停止 A |
| 失败关闭 | B 不可达时拒绝执行，绝不回退到 A |
| 正常授权 | 新设备由用户完成官网设备授权；不用复制旧设备凭据来“伪造”新设备 |

### 1.3 明确不做什么

第一版不重写官网、不自行实现新云端服务、不开发 SSHFS 路线、不重新实现文件/进程工具、不要求 B 开放新的公网端口，也不承诺 RDP/VNC 式图形桌面控制。

**B 仍须有普通 Desktop Commander 后端。** 本方案省掉的是 B 上的 `remote` 云端连接职责，不是省掉 B 上的一切程序。B 的普通后端由 A 通过 SSH 自动启动，B 不需要人工另开一个常驻终端。[S3][S12]

A 必须保持运行和网络连通。即使 ChatGPT 看起来在直接控制 B，通信物理上仍经过 A。这个区别应写入部署说明，不应宣传成 A 关机后仍可访问 B。

### 1.4 第一版架构选择

采用 **一个 profile 一个独立进程**。A 原有本地设备维持原样，再启动一个服务 B 的 SSH profile 进程。以后接入 C、D，可先重复这个部署方式，不必一开始就做单进程多节点调度器。

这样做的目的是减少身份混用、进程全局状态、信号处理和故障传播问题。它是本方案的工程选择，不是上游已经提供的功能。

---

## 2. 已核查的上游事实

官方开源仓库是 `wonderwhy-er/DesktopCommanderMCP`，许可证为 MIT。本次读取的 `main` 中 `package.json` 标记版本为 `0.2.51`。这仅表示已读取源码的版本字段，**不等于已经确认 npm 最新发布版本，也不等于已经取得不可变提交快照**。[S1]

工程实施前必须记录 `git rev-parse HEAD`、lockfile 摘要、Node/npm/OpenSSH 版本和构建产物摘要。本文以函数/文件定位为主；行号可能随上游变化。

| 上游文件/位置 | 已确认行为 | 本需求的实现意义 |
|---|---|---|
| `src/index.ts` | `remote` 分支调用 `runRemote()`；普通分支启动 stdio MCP 服务 | A 跑 `remote`，B 跑普通后端 |
| `src/npm-scripts/remote.ts` / `runRemote()` | 负责 remote 参数、logout 和创建 `MCPDevice` | CLI 改动应主要放在这里，不是只改 `index.ts` |
| `src/remote-device/desktop-commander-integration.ts` / `resolveMcpConfig()` | 当前选择本地构建或本地全局命令，通过 `StdioClientTransport` 连接 | 这里可新增 SSH 后端分支 |
| 同文件 / `ensureReady()`、`callClientTool()` | 有后端重建入口和工具转发入口 | 可保留转发模型，改进生命周期 |
| `src/remote-device/device.ts` | 使用固定的用户目录保存设备 ID/session；设备名取本机 hostname | 需要配置档隔离与显式设备名 |
| `src/remote-device/device-authenticator.ts` | 设备授权请求包含设备名；轮询结果可返回服务端 device ID | B 必须走独立授权，并使用服务端返回的 ID |
| `src/remote-device/remote-channel.ts` / `registerDevice()` | 查找已经存在的设备行并更新、订阅，不会在缺失时自动创建 | 不可只在本地生成 UUID 后直接注册 |
| 同文件 / 状态与 Presence | 数据库状态、心跳、Presence 有多条更新路径 | 后端掉线不能仅写一次 `offline` |

上述事实来自 [S2]—[S6]；后文描述的接口、配置、命令行选项均是**待开发设计**，不是宣称上游已实现。

### 2.1 一个需要前置验证的云端限制

本次源码中的 `registerDevice(capabilities, ...)` 虽接收工具列表参数，但写入的 capabilities 来自另一构造方法，主要包含程序版本和传输标志，并不是原样上传该工具列表。因此，不能推定“B 本地增加/修改工具 schema 后，官网和 ChatGPT 就会自动发现”。[S6]

**第一版保留已有工具名与 schema，并将“官网设备登记、设备选择、模型实际可见参数”列为端到端前置验证。** 不需要为 SSH 添加 `ssh_read_file` 之类的新工具。

### 2.2 可行性结论的准确表述

公开客户端源码提供了明确的 SSH 替换点和独立设备授权路径。由此判断，**优先尝试仅修改客户端、复用现有官网的路线**。

但官网后台及客户端工具目录并未在本次核查中完整验证。是否需要上游配合，以阶段 P0 的实测为准，不预先承诺“官网绝对无需任何改动”。

---

## 3. 总体架构

```text
ChatGPT 中现有的 Remote Desktop Commander 应用
                        │
                        ▼
             Desktop Commander 原有云端
                        │
            按 B 的独立 device_id 路由
                        │
                        ▼
机器 A：remote --profile node-b
  ├─ ProfileLoader / ProfileStateStore
  ├─ DeviceAuthenticator / RemoteChannel
  ├─ BackendSupervisor
  └─ MCP Client → 系统 OpenSSH 客户端
                        │
                  SSH stdin/stdout
                        │
                        ▼
机器 B：固定启动脚本
  └─ 普通 Desktop Commander MCP 后端
       ├─ B 的文件系统
       ├─ B 的命令与进程
       └─ B 的应用配置、工具历史和搜索会话
```

MCP 的 stdio 传输通过标准输入输出传递 JSON-RPC；SSH 支持远端命令及其标准流，所以可以由 A 的 MCP 客户端把 SSH 进程当成后端进程的传输入口。此处是协议组合，不是把每次工具调用翻译成 Shell 命令。[S7][S9]

### 3.1 调用必须保持原样

例如收到 `read_file({path: "/home/dc/workspace/train.py"})` 时，A 将工具名和参数交给 B 的 MCP 后端；不能在 A 上执行 `fs.readFile`，也不能先下载到 A 再冒充 B 的文件读取。

同理，`get_config` / `set_config_value` 操作 B 后端的配置，不能意外修改 A 上的连接 profile。B 返回的 PID、工作目录、搜索会话应来自 B，不是 A 的 SSH 进程 PID。[S13]

### 3.2 管理命令与执行命令分开

上游在设备层特殊处理 `ping` 和 `shutdown`，不完全等同于普通后端工具。[S4]

本方案规定：

- 设备层 `ping` 必须确认 B 的 MCP 后端可响应后再成功返回，不能只证明 A 进程还活着。
- 设备层 `shutdown` 只停止当前 node-b 连接实例及其受管后端，不是关闭 A 操作系统，也不是关闭 B 操作系统。
- 不通过工具参数指定另一个 SSH host。目标节点只由 A 上的受信 profile 决定。

---

## 4. 对外配置与命令行设计

### 4.1 建议新增命令

以下命令都是**完成改造后的目标接口**，原版目前不能直接按此执行。

```bash
# 预检查：启动并检测 B 后端，不注册云端设备，不修改业务文件
node /opt/rdc-ssh/dist/index.js remote \
  --profile node-b --config /home/alice/.config/rdc-ssh/node-b.json --doctor

# 首次登记：验证 B，完成浏览器授权，保存独立设备状态后退出
node /opt/rdc-ssh/dist/index.js remote \
  --profile node-b --config /home/alice/.config/rdc-ssh/node-b.json --enroll

# 正常运行；无有效授权时返回 AUTH_REQUIRED，不在服务中弹浏览器
node /opt/rdc-ssh/dist/index.js remote \
  --profile node-b --config /home/alice/.config/rdc-ssh/node-b.json --non-interactive

# 清除本 profile 的本地云端凭据，不等同于官网 Revoke
node /opt/rdc-ssh/dist/index.js remote --profile node-b --logout
```

`--doctor` 会启动 B 后端，因而可能创建其自身配置、缓存和日志；不要描述成绝对零写入。它不得更改用户业务文件。

保留原版不带 profile 的运行方式、默认状态文件和 logout 行为。profile 模式必须严格解析未知选项，防止拼错 `--profile` 后意外启动本地模式。

### 4.2 Profile JSON

以下路径和 hostname 都是示例，应由部署人员替换。

```json
{
  "schemaVersion": 1,
  "profile": "node-b",
  "deviceName": "node-b (via machine-a)",
  "backend": {
    "type": "ssh",
    "sshExecutable": "/usr/bin/ssh",
    "sshConfigFile": "/home/alice/.ssh/rdc_config",
    "hostAlias": "rdc-node-b",
    "remoteLauncher": "/home/dc/.local/bin/rdc-stdio"
  },
  "verification": {
    "expectedHostname": "node-b",
    "expectedUser": "dc"
  },
  "lifecycle": {
    "initializeTimeoutMs": 20000,
    "healthIntervalMs": 30000,
    "healthTimeoutMs": 5000,
    "healthFailureThreshold": 3,
    "reconnectMaxDelayMs": 30000,
    "shutdownGraceMs": 8000
  }
}
```

规则：profile 名只允许字母、数字、`_`、`-`，长度上限 64；设备名是显示用途，不参与路径拼接；命令行与配置里的 profile 必须一致。配置文件不得内嵌密码、私钥或云端令牌。SSH 可执行文件/配置文件用 A 的绝对路径，启动脚本用 B 的绝对路径。

`expectedHostname` / `expectedUser` 是防误连检查，不替代 SSH host key 验证。节点重装、账号调整或目标迁移后，不得自动接受新的绑定；由运维明确确认。

### 4.3 SSH 配置

在 A 的专用 SSH 配置文件中放置：

```sshconfig
Host rdc-node-b
    HostName 10.0.0.25
    Port 2222
    User dc
    IdentityFile /home/alice/.ssh/id_ed25519_rdc_node_b
    IdentitiesOnly yes
    UserKnownHostsFile /home/alice/.ssh/known_hosts_rdc
    StrictHostKeyChecking yes
    BatchMode yes
    RequestTTY no
    ForwardAgent no
    ClearAllForwardings yes
    ServerAliveInterval 15
    ServerAliveCountMax 3
    ConnectTimeout 10
    ConnectionAttempts 1
    ControlMaster no
    ControlPath none
```

这些 SSH 选项分别用于批处理认证、主机身份核验、禁用终端与无关转发、探测断线。本地 OpenSSH 的实际版本是否支持所选选项，应由 `--doctor` 校验；不要默默忽略错误。[S9][S10]

主机公钥应先通过管理员提供的可信指纹核对并写入专用 known_hosts。`ssh-keyscan` 只能收集公钥，不能独立证明公钥可信；不能通过关闭 `StrictHostKeyChecking` 来完成自动化验收。[S17]

允许通过受信 SSH 配置增加跳板机，但第一版以 A 可直接 SSH 到 B 的环境验收。不要由模型动态生成 `ProxyCommand`、`LocalCommand`、`Match exec` 等配置。

---

## 5. 设备身份与持久化

### 5.1 路径布局

```text
A 的用户目录/
  .desktop-commander-device/
    device.json                     # 原有 A，保持兼容
    profiles/
      node-b/
        device.json                 # node-b 的云端 ID 与令牌
        binding.json                # 目标绑定与已核验信息，不含私钥
        instance.lock               # 防止重复启动
        audit.jsonl                 # 脱敏事件与调用状态
      node-c/
        ...
```

profile 源配置位于 `~/.config/rdc-ssh/`，运行状态位于上述目录。profile 配置与运行凭据分离，避免工程同事把凭据跟源码提交或打包。

### 5.2 必须修改的入口

将 `getRemoteDeviceConfigPath()` 扩展成接收 profile 的路径解析器，所有加载、保存、令牌刷新、清理、logout 都必须调用同一解析器。不能只改构造函数中的路径，而漏掉 `src/npm-scripts/remote.ts` 的 logout。[S2][S4]

将设备名作为显式参数传入 `DeviceAuthenticator` 和 `MCPDevice`，授权请求与最终注册使用同一个值。不要修改系统 hostname，也不要全局替换所有 `os.hostname()`；A 的运行诊断与 B 的设备显示信息应分开。

### 5.3 首次登记与重启

首次 `--enroll`：验证 profile → 获取实例锁 → 连接 B 并核验 → 发起设备授权 → 用户在 A 的浏览器确认 → 接收服务端 device ID/session → 保存到 node-b 状态目录。

正常重启：读取 node-b 的凭据并恢复原 ID。不要每次启动都新建设备；也不要复制 A 的 `device.json` 作为 B 的初始值。

当前服务端返回的设备 ID 才是后续注册的依据。单独生成本地 UUID 不能替代官网登记。[S5][S6]

### 5.4 并发、损坏和撤销

同一 profile 在同一个状态目录下只能有一个活跃实例。建议复用项目已有的锁库实现实例锁；第二个实例应在 SSH 或授权开始前退出。

保留原有令牌轮换保存链与原子替换，并为 POSIX 目录/凭据设置 0700/0600；Windows 使用等效用户 ACL。凭据损坏、读取权限错误不能一律当成“第一次运行”，应返回 `STATE_CORRUPT` / `STATE_UNREADABLE`，避免自动生成大量重复设备。

官网 Revoke 后不得以旧 session 静默恢复设备。交互模式允许用户重新执行 `--enroll`；无人值守模式退出并等待管理员。运行中撤销和重启后撤销两条路径都要验收。不能仅等待账号 JWT 过期；应使用实际设备存在性/云端拒绝反馈识别撤销，并区分“已确认设备不存在”和“查询网络失败”。

不支持把同一个 profile 状态目录复制到另一台 A 同时运行。若需要跨 A 高可用，是后续独立功能。

---

## 6. SSH 后端实现

### 6.1 建议的代码结构

```text
src/remote-device/
  backend-config.ts                 # 配置类型与校验（新增）
  ssh-backend.ts                    # SSH 启动参数与诊断（新增）
  backend-supervisor.ts             # 重连与健康检查（新增）
  profile-state.ts                  # profile 路径、锁、绑定（新增）
  desktop-commander-integration.ts  # 保留 MCP 工具转发，支持 local/ssh
  device-authenticator.ts          # 显式设备名
  device.ts                        # profile 生命周期、身份、路由
  remote-channel.ts                # 后端健康参与在线状态与 Presence

src/npm-scripts/remote.ts           # CLI 参数与 profile 作用域 logout

test/
  remote-ssh/                      # 新增测试目录；按项目测试入口集成
```

不强制一次抽象出复杂插件系统。最小实现可以给 `DesktopCommanderIntegration` 注入经过校验的 backend 配置，在 `resolveMcpConfig()` 的最前面处理 SSH 类型。

**显式配置为 SSH 后，任何异常都必须抛出；不允许继续执行原有本地构建/全局命令探测逻辑。**

### 6.2 参数构造参考

下面是接口与核心构造逻辑示例，不是完整补丁。实际类型、SDK API 应以锁定的依赖版本为准。[S8]

```ts
import path from 'node:path';
import {
  getDefaultEnvironment,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';

export interface SshBackendConfig {
  type: 'ssh';
  sshExecutable: string;
  sshConfigFile: string;
  hostAlias: string;
  remoteLauncher: string;
}

function quotePosix(value: string): string {
  if (/[\u0000\r\n]/.test(value)) {
    throw new Error('Remote path contains forbidden control characters');
  }
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function makeSshParameters(
  config: SshBackendConfig,
): StdioServerParameters {
  if (!path.isAbsolute(config.sshExecutable) ||
      !path.isAbsolute(config.sshConfigFile)) {
    throw new Error('Local SSH executable and config paths must be absolute');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.hostAlias)) {
    throw new Error('Invalid SSH host alias');
  }
  if (!config.remoteLauncher.startsWith('/')) {
    throw new Error('V1 requires an absolute POSIX remote launcher path');
  }

  const env = getDefaultEnvironment();
  // 用于 A 的 SSH 认证；不表示将 agent 转发给 B。
  if (process.env.SSH_AUTH_SOCK) {
    env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  }

  return {
    command: config.sshExecutable,
    args: [
      '-F', config.sshConfigFile,
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ConnectionAttempts=1',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ForwardAgent=no',
      '-o', 'ClearAllForwardings=yes',
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      config.hostAlias,
      `exec ${quotePosix(config.remoteLauncher)}`,
    ],
    env,
    stderr: 'pipe',
  };
}
```

这里不设置 A 的 `cwd` 来表示 B 的工作目录；B 的 cwd 在远端启动脚本内设置。

虽然本地启动使用参数数组且不启用本地 shell，SSH 的远端 command 仍由远端 shell 解释，因此必须对远端启动路径转义。工具参数、用户文件内容、模型生成命令不应拼入这个连接命令；它们随后通过 MCP JSON-RPC 传输。[S9]

### 6.3 标准流规则

SSH 进程的 stdin/stdout 专用于 MCP。禁止使用 `ssh -n`、`-N`、`-f` 或 `-tt`；禁止 `2>&1`；禁止在普通后端前启动会向 stdout 打印提示的交互登录流程。

B 的 `.bashrc`、系统登录脚本、启动器不得向协议 stdout 输出欢迎语。MCP 合法日志通知不应被任意删除；原始 stderr 要单独消费，不能“收到 stderr 就判定执行失败”。协议对日志和 stdio 的区分见 [S7]。

示例设置了 `stderr: 'pipe'`，因此实现时必须在启动前订阅并持续读取 `transport.stderr`，设置有界环形诊断缓存并脱敏。只开管道而不消费，可能使子进程阻塞。不要把 stderr 合并进 MCP 输入解析器。

### 6.4 环境变量分层

**A 的连接进程环境**可以含云端凭据和代理配置；**A 的 SSH 子进程环境**仅保留必需变量；**B 的后端环境**由远端启动器设置。这三层不能混为一谈。

当前集成层给本地子进程设置 `DC_REMOTE_DEVICE=true`，用于抑制部分本地交互行为；把子进程换成 SSH 后，这个变量不会自动成为 B 的环境。必须在 B 启动脚本里显式设置。[S3]

SDK 默认继承环境不包含所有用户会话变量，尤其不能假定 GUI/服务启动时自动获得 `SSH_AUTH_SOCK`。只按需传入 A 的 SSH 客户端；不要复制整个 `process.env`，不要向 B 发送 A 的云端令牌。[S8][S10]

### 6.5 初始化与能力校验

执行顺序：创建 SSH transport → 注册诊断监听 → MCP initialize → 完成 initialized 握手 → 完整获取 tools/list → 核验必需工具与 B 身份 → 设置 backend ready。

`tools/list` 失败、空列表或必需工具缺失必须作为失败，不应沿用上游返回空工具列表后继续的宽松路径。支持分页时读取完整列表；计算 canonical schema hash 供回归比较。

初始化超时后必须关闭对应 client/transport，清除 timer，作废该连接世代。仅用 `Promise.race` 返回超时而留下后台 SSH，不能视为正确清理。不得发送 MCP 对 initialize 的取消通知；握手失败按关闭连接处理。[S11]

沿用 SDK 对 transport 的回调所有权；在 Client 层监听连接关闭，不要用自定义 transport 回调覆盖 SDK 自己的消息/关闭处理。[S3]

### 6.6 机器信息与版本信息不能混用

在 B 的 MCP 连接完成后，通过同一连接执行内部、固定的只读探测，取得 B 的 hostname、用户、platform、arch 与后端版本，并按 profile 核验。没有可靠后端字段时，可以调用原有 `start_process` 执行受信的固定探测命令并解析结果；这属于连接程序内部预检查，不需要模型操作 SSH。

当前 Presence 使用连接进程的 `process.platform`，在 SSH 模式下它代表 A。应让 `RemoteChannel` 接收经过核验的 B 执行环境信息，在与官网现有字段兼容的前提下用于逻辑设备描述；A 的系统信息另留在 bridge 诊断中。[S6]

不要将全部版本字段替换成 B 的版本：云端传输用的 `app_version` 应仍准确反映 A 连接端实际实现；B 后端版本与其 schema hash 独立记录。第一版不依赖新增云端字段，必要信息先保存在本地诊断与启动报告中。

---

## 7. B 端部署与启动器

### 7.1 部署原则

使用普通权限账号，例如 `dc`。在 B 或与 B 同操作系统/架构的构建环境准备固定版本后端和依赖。运行期不使用 `@latest`，不依赖每次 `npx` 在线下载。

可采用固定 commit 的源码构建包，或经确认存在的固定 npm 发布版。A 修改版与 B 普通后端应记录兼容组合。不要把 A/Windows 的 `node_modules` 原样复制到 B/Linux；项目含平台相关依赖，离线交付需要制作 B 适用的完整运行包。[S1]

### 7.2 启动脚本示例

安装在 B 的 `/home/dc/.local/bin/rdc-stdio`：

```sh
#!/bin/sh
set -eu
umask 077

export DC_REMOTE_DEVICE=true
export PATH=/usr/local/bin:/usr/bin:/bin

cd /home/dc/workspace
exec /usr/bin/node \
  /home/dc/.local/share/rdc-runtime/dist/index.js \
  --no-onboarding
```

为脚本设置执行权限，按实际安装调整 Node 路径、后端路径和工作目录。不要在这里加 `remote`。需要 Python/Conda 时，在 B 上明确配置对应环境或使用目标环境的绝对路径，而不是依赖 A 的环境或交互 shell 的自动初始化。

### 7.3 没有外网的 B

控制链不要求 B 直连官网，但不能据此声称普通后端完全不发起网络请求。当前启动逻辑包括功能开关获取、Chrome 可用性检查等，遥测与某些工具也可能涉及网络。[S12][S14]

因此，部署规格应区分：

1. **无需 B 直连云端控制服务。** 本方案的基本目标。
2. **B 无公网时基础工具可用。** 预装依赖、测试文件/命令/搜索路径。
3. **B 严格零出站网络。** 额外的可选交付项：核查并关闭/预置遥测、功能开关、浏览器下载等，必要时增加明确的 offline 启动模式，同时做出站阻断测试。

`--no-onboarding` 不是“完全离线开关”。不要通过伪造 URL 或大量吞掉网络错误来代替正式离线适配。

### 7.4 身份验证

生产绑定以 SSH 主机密钥和账号为基础；hostname/user 是补充防误连检查。工程验证应至少包含：B 后端自身返回系统信息、在 B 的测试目录读写唯一标记、由独立 SSH 检查该标记确实落在 B。

A 与 B 可能共享 NFS 目录，不能仅用共享目录中的标记证明执行位置。应选 B 的非共享临时目录，并同时核对 hostname/user。

---

## 8. 在线状态、健康检查与恢复

### 8.1 在线定义

```text
逻辑设备可用 = 云端授权有效
            ∧ 云端请求通道已就绪
            ∧ B 的 SSH/MCP 后端通过健康检查
            ∧ 当前实例没有进入停止/撤销状态
```

不能只判断 SSH 端口开放，也不能只判断 A 连接官网成功。

### 8.2 状态机

```text
STARTING
  → CONFIG_VALIDATED
  → SSH_CONNECTING
  → MCP_INITIALIZING
  → BACKEND_READY
  → AUTH_READY
  → ONLINE

可恢复后端故障： ONLINE → BACKEND_OFFLINE → RETRY_WAIT → SSH_CONNECTING
授权需要人工：   任意状态 → AUTH_REQUIRED
身份/配置异常：  任意状态 → BLOCKED
停止：          任意状态 → STOPPING → STOPPED
```

首次 `--enroll` 与正常运行的具体授权时机可实现为两个命令流程，但在宣告 ONLINE 前必须满足同一可用性条件。

### 8.3 必须统一在线写入路径

当前源码中注册、心跳、连接重建、Presence 等会分别影响在线状态。单独在 SSH 断开时写一次 `offline`，可能随后被仍然健康的云端通道重新覆盖。[S6]

增加 `backendReady` 状态输入，统一审核下列方法：

```text
registerDevice
syncReachabilityStatus / queueStatusWrite
updateHeartbeat / setOnlineStatus
trackPresenceInner / trackPresenceWithRetry
云端通道重建后的状态发布
设备层 ping
```

要求所有宣告 online 的分支都经过统一可用性判断。后端故障时撤回/停止发布可用 Presence，并发布 offline；保留令牌刷新和必要的云端诊断能力。不要为标记 B 掉线而停掉整个认证刷新机制。

`transport_broadcast_v1` 是现有传输能力标志，不能未经验证拿来充当“B 健康”开关。修改时保留其原有协议语义，并测试客户端/官网对 `status` 与 Presence 的实际取值行为。

所有异步状态更新使用有序写入与连接世代校验；旧连接的迟到成功回调不能把新的离线实例重新变成在线。

### 8.4 健康检查建议值

SSH 连接超时 10 秒；MCP 初始化 20 秒；后端 MCP ping 每 30 秒一次、单次等待 5 秒、连续 3 次失败判离线。正常 MCP 回复可刷新最近健康时间，避免后台重任务时过度误判。

这些是初始工程参数，不是官方 SLA。需要区分故障类别：进程明确退出可立即判离线；网络黑洞由 SSH keepalive 与 MCP 健康检查共同识别。MCP ping 的协议依据见 [S11]。

如果 A 到官网也断开，就无法立刻更新 Devices 页面；应依赖云端自己的过期检测，不能承诺页面瞬时变灰。A 本地拒绝错误执行的策略仍然必须立即生效。

### 8.5 重连

可恢复连接错误按 1、2、4、8、16、30 秒封顶并加入抖动重试，一次只允许一个初始化流程。一个连接失败不自动重新授权，也不重新分配 device ID。

主机密钥不匹配、profile 错误、已确认的凭据/权限错误、B 启动路径不存在等进入 BLOCKED，由人员处理；无法可靠分类时给出 SSH 退出码和脱敏 stderr，不能把所有 255 退出码都说成网络错误。

云端 `online` 不能成为发起重连的前提：设备离线后可能收不到新工具调用，所以恢复必须由本地 supervisor 主动驱动。

---

## 9. 请求语义：重复、超时与错误

### 9.1 路由约束

在云端消息进入设备层时校验目标 device ID；有明确不匹配的请求直接拒绝。当前协议应要求执行消息带目标 ID；历史兼容路径如需接受缺失 ID，必须证明上游已完成设备绑定，而不是默认允许。

模型工具参数不能改变 profile、SSH host、云端设备 ID 或本地状态目录。

### 9.2 不自动重放工具调用

**允许自动重连，不允许因为没有收到结果就自动再次执行工具。** B 可能已完成写文件、删除或启动程序，只是响应在返回途中丢失。

设计目标是：在本连接器的控制范围内避免重复派发，保留“结果未知”状态；不宣称跨云端、SSH 和 B 的分布式 exactly-once。

建议为收到的云端 call ID 维护有界、可恢复的本地日志：

```text
RECEIVED → DISPATCH_INTENT_RECORDED → COMPLETED
                                 → FAILED_KNOWN
                                 → RESULT_UNKNOWN
```

发送前先记录派发意图。重启后遇到旧的派发记录，不自动重发；可返回结果未知。结果已经获得但上传云端失败时，只重试上传结果，不重试 B 的工具操作。

去重针对相同云端 call ID。模型或用户重新发起同样业务操作但使用新 ID，不在这一层的自动去重保证内；重要业务仍需要业务级幂等设计。日志应包含目标绑定摘要和参数摘要，相同 ID 对应不同请求时拒绝执行。保留窗口必须覆盖经验证的消息重投窗口；过期记录不能支撑无限期去重承诺。

如需要持久化结果以重试云端上传，完整结果应放在单独受保护、限时保留的缓存，不进入默认 audit 日志。未保存结果的已派发操作，重启后只报告未知，不能重新执行来“补出结果”。

这个日志不是跨系统原子事务；即使在“记录后、真正发送前”崩溃，也允许保守地标记未知，不能用猜测换取看似成功。若只实现内存去重，交付说明必须明确跨重启的保障缺口，不能通过生产可靠性验收。

### 9.3 错误分类

| 建议错误码 | 含义 | 默认处理 |
|---|---|---|
| `PROFILE_INVALID` | 配置不合法 | 阻止启动 |
| `PROFILE_ALREADY_RUNNING` | 同 profile 已在运行 | 第二实例退出 |
| `AUTH_REQUIRED` | 无可用官网授权 | 人工 enroll |
| `SSH_CONNECT_FAILED` | SSH 连接失败，原因见诊断 | 按可恢复性处理 |
| `SSH_HOST_KEY_MISMATCH` | 已确认主机身份不符 | 阻断，不自动接受 |
| `BACKEND_INIT_FAILED` | B 后端未完成握手/能力检查 | 离线与诊断 |
| `BACKEND_UNAVAILABLE` | 当前后端不可用且请求未发送 | 快速失败 |
| `REMOTE_RESULT_UNKNOWN` | 请求可能已经执行，结果无法确认 | 不自动重放 |
| `SESSION_CONTEXT_LOST` | 旧后端会话不可继续使用 | 重新枚举/重建会话 |
| `DEVICE_REVOKED` | 官网设备被撤销 | 停止执行，人工授权 |
| `STATE_CORRUPT` | 设备状态损坏 | 停止并保留证据 |

第一版沿用官网现有结果/错误外层格式，不添加未经验证的数据库列或状态枚举。上述代码可以先放入可见错误文本和本地结构化日志，后续再考虑服务端结构化支持。

后端返回的 `isError`、文本、图片及其他合法结果字段应保持协议结构，不能把所有响应 stringify 成一段文本后丢失字段。

### 9.4 超时与取消

SSH 建连、MCP 初始化、单次工具 RPC、进程输出等待、云端请求超时是不同层次。不要把 `start_process.timeout_ms` 当成进程总生命期，也不要只把 SDK 超时无限调大来规避官网等待限制。

超时不等于远端取消成功。MCP 取消是可选机制，接收端可能已执行完毕或无法取消；需要保留未知结果，不报告“已撤销”或“已回滚”。[S11]

长任务使用短请求启动，后续读取输出。超大文件/输出按原有分页限制处理；验收应测 1 KiB、100 KiB、1 MiB 等测试载荷并记录整条链路的实际上限，不承诺 SSH 能传多大文件就代表官网接受同样大的单次工具返回。

---

## 10. 进程会话、长任务与清理

### 10.1 会话属于 B 后端的某一代连接

正常连接期间，`start_process` / `read_process_output` / `interact_with_process` / `force_terminate` 和搜索会话应共享同一个 B 后端进程，不要每次调用新开一个后端。[S13]

后端重启后，不保证原有进程/搜索会话对象仍存在。第一版不承诺断线恢复原交互会话，也不自动重启用户任务。

PID 可能被复用。连接器应记录当前 backend epoch 与已确认会话关系，对旧 epoch 的会话操作返回 `SESSION_CONTEXT_LOST`，必要时要求重新枚举会话。不能把 A 的 ssh PID 作为 B 会话 PID。

**兼容限制：** 现有部分工具只接收数字 PID，没有独立 epoch 参数，因此不能完整区分“旧请求里的 PID”和“后来复用的同一 PID”。保守实现应拒绝已知失效 PID 的危险操作，不宣称实现了完全透明的跨重连会话安全。需要无歧义跨重连句柄时，应另行设计后端会话 token 与云端 schema 协调，不暗中增加模型不可见的必填参数。

### 10.2 长任务独立托管

训练、长构建等确需断线存活的任务，交由 B 上现有调度系统、systemd 服务或其他明确的持久任务机制。连接器不负责把任意命令自动改写成后台持久任务。

部署手册应区分“受当前 MCP 会话管理的进程”和“用户明确提交的持久任务”。停止连接器不得误杀后一类；也不能承诺所有前一类任务在任何 SSH 异常后自动存活。

### 10.3 关闭流程

停止接收新工具 → 标记停止状态并取消重连 → 撤回在线公告 → 结束/标记在途请求 → 关闭 MCP client/SSH → 刷新本 profile 的令牌和日志 → 释放锁并退出。

同一关闭期限内做资源清理，避免外层 5 秒强退与内层多次等待叠加造成永远没有机会完成。应使可配置的 `shutdownGraceMs` 与设备层退出计时协调，不能只改一处计时器。[S3][S4]

`StdioClientTransport.close()` 管理的是 A 上的本地子进程；换成 SSH 后，杀掉这个子进程不构成“B 上所有子孙进程已清理”的证明。[S8]

因此必须在 B 上验证 EOF、SSH 中断、MCP 崩溃后的实际进程状态。如果普通后端不能满足清理要求，补充 B 端 stdio EOF/signal 处理或小型 supervisor。清理仅针对本实例拥有的后端/临时进程组；不得使用 `pkill node`、按用户名杀进程或其他可能波及无关作业的方式。

网络完全中断时，A 无法立即证明 B 已退出。日志应记为 `CLEANUP_UNCONFIRMED`，下次恢复后核对；对持续驻留风险有严格要求的环境，应额外配置 B 端会话租约/受管运行单元。这是增强项，不是伪装成 SSH 自带的保证。

---

## 11. 安全与权限

本改造提供的是 B 账号的文件和命令能力，不是安全沙箱。上游安全说明也将目录白名单和命令黑名单定义为防误操作措施，而非强隔离边界。[S15]

基本要求：B 使用普通权限/专用账号；私钥留在 A；只在 A 使用 agent，不转发 agent 给 B；绑定经过核验的 SSH 主机身份；A 的 profile/凭据不通过 B 的工具接口公开；不要默认授予 sudo；不要让可修改的项目文件决定连接地址或启动脚本。

若要限制模型只能访问某个工程，应使用 B 的系统权限、容器或虚拟机，而不是只设 `allowedDirectories`。

日志默认只记录 profile、设备 ID 的可脱敏标识、call ID、工具名、耗时、错误类型、连接世代和退出码；不打印整个 tool_args/result、SSH 私钥、令牌和文件正文。上游已有较详细调用日志，改造时需要明确它们的本地存放位置和保留策略，不能简单声称所有日志已经脱敏。

业务工具参数经过现有 Desktop Commander 云端再到 A/B；SSH 加密保护的是 A—B 链路，不意味着业务内容对云端不可见。

---

## 12. 开发阶段与交付顺序

### P0：真实链路可行性验证——优先完成

只做必要改造：SSH 后端、profile 独立身份/名称、正常授权、禁止本地回退。用测试账号和临时目录验证官网新增 B、ChatGPT 能选择 B、读取/写入/执行确实落在 B。

必须记录 B 的工具 schema、官网暴露 schema、ChatGPT 实际可调用参数；不能只看 Devices 变绿。

**P0 不等于生产可用。** 若官网不允许预期的独立设备授权或路由，或模型没有可用的原有工具 schema，先保存原始请求/响应与版本证据，确认服务端兼容问题；不要投入多节点 GUI、安装器等后续开发来掩盖关键链路未通。

### P1：单节点可靠实现

完成配置校验、profile 全路径隔离、实例锁、目标绑定、在线状态统一、健康检查、主动重连、请求不重放、错误分类、撤销处理、断线清理与回归测试。

### P2：运维与平台适配

形成 A/B 部署包、服务管理示例、doctor、自检报告、日志脱敏、升级回滚；第一验收平台建议 Linux A → Linux B。A 为 macOS/Windows 时分别验证实际 OpenSSH、路径、agent、服务权限和进程终止行为，不把 WSL 网络/凭据环境与 Windows 主机混同。

### P3：可选增强

多 profile 管理界面、受管自动部署 B 后端、严格离线模式、持久任务集成、跨 A 高可用。它们不应成为 P0 的前提。

不在没有工程环境和团队信息时承诺固定工期。先完成 P0 再依据云端兼容和故障测试结果排期。

---

## 13. 构建、运行与回滚

### 13.1 固定开发基线

在工程人员可联网的环境：

```bash
git clone https://github.com/wonderwhy-er/DesktopCommanderMCP.git rdc-ssh
cd rdc-ssh
git rev-parse HEAD
# 将上面的完整 SHA 写入设计基线，再从该基线创建开发分支。
git switch -c feature/ssh-backed-device
npm ci --include=dev
npm run build
npm test
```

这些是项目构建/测试入口的使用示例；新增测试还需接入项目测试 runner，不能假定新建测试目录后 `npm test` 会自动扫描。[S1]

另行记录 lockfile 和构建包 SHA-256、依赖运行时与平台版本。不要使用会更改其他 AI 客户端配置的 `npm run setup` 作为本功能的常规部署命令。

### 13.2 部署顺序

先准备 B 后端和启动器，再从 A 的相同服务账号完成 SSH/known_hosts 验证，再运行 `--doctor`，然后手动 `--enroll`，最后配置无人值守运行。不能在密钥/主机确认还需要交互时直接部署后台服务。

A 的服务要使用原授权用户或明确的专用服务账号；换成 root 往往意味着换了 HOME、known_hosts、密钥和 profile 状态，不能通过“sudo 能启动”就视为同一配置。

### 13.3 Linux A 的 systemd 用户服务示例

以下依赖拟开发的 CLI 已实现，路径按部署调整；服务重启与清理选项依据 systemd 的官方手册。[S16]

```ini
[Unit]
Description=Desktop Commander SSH device node-b

[Service]
Type=exec
WorkingDirectory=/opt/rdc-ssh
ExecStart=/usr/bin/node /opt/rdc-ssh/dist/index.js remote --profile node-b --config /home/alice/.config/rdc-ssh/node-b.json --non-interactive
Restart=on-failure
RestartSec=10
RestartPreventExitStatus=64 65 77 78
TimeoutStopSec=15
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
```

建议退出码约定：64 参数错误、65 状态损坏、77 授权需要人工、78 绑定/部署错误；这些属于本方案新约定。SSH 暂时离线通常由进程内 supervisor 重试，不必反复重启整个服务。用户正常退出/远程 shutdown 返回 0，避免 `Restart=always` 立即把用户关闭的设备拉起。

`systemctl` 启动成功只表示服务进程成功启动，不表示 SSH、B 后端和云端已经全部 ONLINE；是否可用仍查看本方案的状态机。A 上的 `KillMode=control-group` 只管理 A 的服务进程组，不会跨 SSH 管理 B 的进程。[S16]

服务环境若使用加密密钥/agent，必须显式保证服务能访问所需的 agent；不能假定交互 shell 的 `SSH_AUTH_SOCK` 自动存在。是否启用用户服务 logout 后常驻，由运维根据实际主机策略配置并验收。

### 13.4 升级与回滚

升级前固定新旧构建、B 后端版本和 schema hash。停止 node-b 实例，等待状态写入，再切换程序版本；设备凭据继续使用最新有效状态。

**不要把过期备份中的 refresh token 覆盖到正在使用的状态文件。** 回滚程序和回滚认证状态不是同一件事。

回滚只影响 node-b 服务、profile 和 B 对应后端，不卸载或改写 A 原设备。卸载流程需明确区分停止进程、本地 logout 和官网 Revoke；只删除文件不等于撤销云端访问。

---

## 14. 验收测试矩阵

除独立测试目录、测试账号与测试进程外，不应使用真实项目作破坏性故障测试。

| 编号 | 测试 | 必须得到的结果 |
|---|---|---|
| A01 | 原设备回归 | 原 A 名称、ID、凭据、工具执行均未被修改 |
| A02 | 新增 B | 官网出现独立 B，ID 与 A 不同 |
| A03 | 重启 node-b | 恢复同一 B ID，不反复新增设备 |
| A04 | 同时启动同 profile 两次 | 第二实例在授权/SSH 前失败，不发生凭据争用 |
| A05 | profile logout | 只处理 B；活跃实例存在时拒绝或要求先停服务 |
| A06 | 官网撤销 B | B 不再接受执行；重启不能凭旧 session 静默复活 |
| R01 | 读位置核验 | B 的非共享标记返回正确；不存在于 A 的文件仍可读 |
| R02 | 写位置核验 | 只在 B 临时目录生成文件；独立 SSH 回读一致 |
| R03 | 命令位置核验 | hostname、用户、cwd 为 B；无 A 业务命令 |
| R04 | PID/进程核验 | PID 属于 B，能分批读取输出和交互 |
| R05 | 搜索会话 | 连续获取分页结果作用于同一个 B 会话 |
| R06 | 配置工具 | get/set config 操作 B 后端配置，不改 A profile |
| R07 | A/B 共用 NFS | 另用非共享目录和主机信息证明执行位置 |
| S01 | 模型实际 schema | 原有核心工具参数齐全，完成真实精确编辑与回读 |
| S02 | 异构平台 | A 的平台信息不冒充 B；B 路径不被按 A 风格转换 |
| F01 | SSH 启动失败 | 不探测/启动本地后端；日志给出故障信息 |
| F02 | SSH 子进程退出 | 在途请求结束或标未知，设备转离线并主动重连 |
| F03 | B 后端卡死、SSH 仍活 | MCP 健康检查可识别，不能永远显示可用 |
| F04 | 云端健康、B 断开 | 心跳/Presence 不把 B 重新刷成可用 |
| F05 | A—官网断网 | 本地停止错误派发；记录 UI 状态只能最终一致 |
| F06 | 旧连接迟到成功 | 不得覆盖新世代状态，不出现幽灵 SSH/MCP |
| F07 | 请求发出后响应丢失 | 不重放；返回 RESULT_UNKNOWN 类错误 |
| F08 | 云端结果上传失败 | 只重传结果，不再执行 B 工具 |
| F09 | A 进程重启后收到旧 call ID | 使用持久日志避免再次派发已记录请求 |
| F10 | 后端重连后旧 PID/搜索 ID | 拒绝不可信旧会话，不误杀复用 PID |
| C01 | 主机密钥变化 | 连接阻断，不自动删除 known_hosts |
| C02 | stdin/stdout 污染 | 明确失败诊断，stderr 未混入 MCP |
| C03 | 路径含空格、单引号、中文 | 正确引用或明确拒绝，不出现命令注入 |
| C04 | 凭据与日志 | A/B 令牌分离；默认日志不泄露密钥或正文 |
| C05 | 同账号不同 profile | 登录刷新、断线、logout 相互独立 |
| L01 | 正常停止 | A 的 ssh、B 受管后端按规则退出，A 原设备仍在线 |
| L02 | 多次故障/重连 | 无重复后端、无限增长的 timer/监听器/进程 |
| L03 | 持久长任务 | 连接器退出不误杀明确独立托管的任务 |
| L04 | 不同大小载荷 | 分页、错误与大小边界明确，无截断冒充完整结果 |
| L05 | 运行期 B 无公网 | 预定义基础工具可用；外网工具限制明确 |
| L06 | 连续运行覆盖令牌刷新 | 至少验证一次刷新与随后重启，身份保持稳定 |

测试应分三层：纯单元测试（假 SSH/MCP）、受控 SSH 集成测试、真实官网与 ChatGPT 端到端测试。单元测试通过不替代真实设备选择与 schema 验证。

### 14.1 需要保留的验收证据

固定代码与依赖版本；profile 脱敏样例；A/B 系统和 SSH 版本；设备 ID 区分记录；模型实际 schema 摘要；在 B 的独立回读结果；断网/崩溃时间线；重连前后进程清单；日志脱敏检查；原 A 未被修改的回归记录。

不在验收包中包含 access token、refresh token、SSH 私钥或完整私有配置。

---

## 15. 工程交付清单与最终完成定义

工程同事应交付：固定上游 commit 的补丁/分支；可重复构建说明；A 的连接程序；B 的固定后端与启动脚本；profile/schema/SSH 配置样例；doctor；自动化测试；真实端到端验收记录；升级、撤销、卸载和回滚手册；已知平台、工具大小和会话限制。

**最终完成定义：**

> A 原有设备不受影响。B 通过 A 的 SSH profile 在同一 Devices 列表中成为独立且可选择的设备；原有核心工具确实在 B 执行；B 不可用时不回退到 A、不虚报后端可用、不重放结果未知的操作；重启、撤销、令牌刷新和清理经过实测。

“改三处代码”“新设备名称出现”“ping 返回 pong”或“在 A 上手工 SSH 执行过一次 hostname”，都不足以作为最终验收。

---

## 附录 A：建议先提交的最小 PR 划分

| PR | 内容 | 合并前证据 |
|---|---|---|
| PR1 | profile 配置、设备名、身份路径、logout 隔离 | 不带 profile 的兼容测试、双 profile 测试 |
| PR2 | SSH transport 与 B 启动器、无回退 | B 文件/命令实测，SSH 错误测试 |
| PR3 | 官网/ChatGPT P0 验证调整 | 独立设备、真实 schema、真实 B 执行 |
| PR4 | 可用性状态统一、主动重连、清理 | 黑洞/卡死/迟到回调故障注入 |
| PR5 | 持久去重、未知结果、会话边界 | 响应丢失与进程重启不重放 |
| PR6 | 服务部署、日志、回滚、文档 | 全验收矩阵与新机器部署演练 |

PR1—PR3 可以合并到开发分支用于验证，但 PR4—PR6 完成前不标为生产可用。

## 附录 B：主要一手资料

以下资料是核查依据。公开 `main` / SDK `v1.x` 会变化，实施时应改为锁定提交的永久定位；SDK 分支的行为也需要与项目 lockfile 中实际版本核对。

```text
[S1] DesktopCommanderMCP package.json / LICENSE
https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/package.json
https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/LICENSE

[S2] remote CLI
https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/src/npm-scripts/remote.ts

[S3] MCP 后端集成
https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/src/remote-device/desktop-commander-integration.ts

[S4] 设备身份、状态与工具派发
https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/src/remote-device/device.ts

[S5] 设备授权
https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/src/remote-device/device-authenticator.ts

[S6] 云端设备登记、Presence、心跳与状态
https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/src/remote-device/remote-channel.ts

[S7] MCP stdio 传输规范
https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

[S8] MCP TypeScript SDK stdio client
https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.x/src/client/stdio.ts

[S9] OpenSSH ssh 手册
https://man.openbsd.org/ssh

[S10] OpenSSH ssh_config 手册
https://man.openbsd.org/ssh_config

[S11] MCP ping 与取消规范
https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping
https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation

[S12] 普通后端入口
https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/src/index.ts

[S13] 工具参数 schema
https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/src/tools/schemas.ts

[S14] 后台功能开关获取
https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/src/utils/feature-flags.ts

[S15] 上游安全模型
https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/main/SECURITY.md

[S16] systemd 官方手册源码
https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.service.xml
https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.kill.xml

[S17] OpenSSH ssh-keyscan 手册
https://man.openbsd.org/ssh-keyscan
```
