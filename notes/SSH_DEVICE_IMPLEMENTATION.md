# SSH-backed Devices：实现与使用说明

## 1. 目标与实现边界

机器 A 运行修改后的 `remote --profile ...` 连接进程；机器 B 运行普通 Desktop Commander stdio 后端。A 通过 SSH 转发 MCP 请求，B 使用独立授权身份加入现有 Devices。

普通 `remote` 入口仍使用原来的本机设备实现。新增的 SSH 配置实例不会读取或覆盖默认的 `~/.desktop-commander-device/device.json`，也没有 SSH 失败后切换到本地执行的分支。

本次采用独立 `SshProfileDevice` / `SshBackend`，而不是给原 `MCPDevice` 加大量条件分支。共享的云端通道只增加可选的后端可用性约束及严格写入接口。

**限制：B 仍需安装普通 Desktop Commander 和运行环境；A 必须保持运行。该功能不包括图形桌面控制，也没有把节点执行权限隔离成安全沙箱。**

## 2. 代码位置

| 文件 | 职责 |
|---|---|
| `src/remote-device/ssh-profile-config.ts` | 严格配置、CLI 校验和目标绑定摘要 |
| `src/remote-device/profile-state.ts` | 独立凭据、原子落盘、实例锁 |
| `src/remote-device/ssh-backend.ts` | SSH stdio、真实后端身份核验、会话世代 |
| `src/remote-device/backend-supervisor.ts` | 主动重连、健康探测、停止控制 |
| `src/remote-device/call-journal.ts` | 持久派发记录、结果缓存、重复请求保护 |
| `src/remote-device/profile-dispatcher.ts` | 路由、授权检查、只重传结果而不重做操作 |
| `src/remote-device/ssh-profile-device.ts` | 授权、服务生命周期、自检和退出 |
| `src/remote-device/remote-channel.ts` | 后端状态约束心跳 / Presence，严格调用状态更新 |
| `examples/ssh-device/` | 配置、B 启动器和可选服务示例 |

原 `device.ts` 和 `desktop-commander-integration.ts` 的本机工具执行实现未被替换。

## 3. 初次使用

### 3.1 构建 A 上的修改版

在仓库目录使用已验证的现代 Node.js。不要替换系统默认 Node，也不要用 `npx ...@latest remote` 启动本修改版。

```sh
# 示例使用用户目录中的 Node；按实际安装位置修改。
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
npm run build
```

本次开发依赖通过锁文件安装，安装时跳过生命周期脚本，避免自动下载浏览器等副作用。新环境应确认所需原生依赖可用；搜索等额外工具还需单独验证。B 上使用预先安装好的、固定版本的普通后端，不在每次 SSH 连接时下载 `@latest`。

### 3.2 准备 B 与 SSH 配置

将 `examples/ssh-device/rdc-stdio.example.sh` 按实际路径修改后放在 B，赋予执行权限。脚本中只有普通后端入口，没有 `remote`。stdout 不允许打印欢迎语、调试信息或登录提示。

将 `ssh_config.example` 复制到 A 的仓库外私有配置目录，配置 B 的地址、账号、端口及已有认证方式。首次信任主机密钥必须由操作人员核验；程序不会关闭主机密钥检查，也不会自动接受变化后的密钥。

将 `node-b.example.json` 复制到仓库外，再替换绝对路径和 `expectedHostname` / `expectedUser`。二者必须分别与 B 上 `hostname` 和 `id -un` 的结果一致。

示例账号和地址只是占位符，不代表当前已配置任何真实服务器。

### 3.3 先自检，再授权，再运行

```sh
# 不连接云端；验证 SSH、MCP 初始化、完整工具列表和节点身份。
node dist/index.js remote --profile node-b --config /absolute/path/node-b.json --doctor

# 在浏览器完成此 profile 的独立设备授权，成功后退出。
node dist/index.js remote --profile node-b --config /absolute/path/node-b.json --enroll

# 使用保存的身份持续运行。此命令不会自动重新弹出授权。
node dist/index.js remote --profile node-b --config /absolute/path/node-b.json --non-interactive
```

`--doctor` 会通过 B 的 `start_process` 执行固定的 `hostname`、`id -un`、`uname` 检查。它不修改业务文件，但普通后端可能创建自己的配置、日志和缓存，因此不是绝对零写入操作。`BACKEND_VERIFIED` 不等于云端登记、模型可见 schema 或所有工具功能已经通过端到端验收。

`--enroll` 保存云端返回的设备 ID，不伪造 ID、不复制 A 的设备凭据。重复执行时，有效的原身份会被恢复；损坏、丢失或撤销的身份不会静默变成新设备。

### 3.4 退出与改配置

```sh
# 只删除 node-b 的本地凭据和绑定，不影响默认本机设备。
node dist/index.js remote --profile node-b --logout
```

运行中的实例持有配置锁；先正常停止该实例，再 logout。官网撤销与本地 logout 是不同操作。若要更换 B 或调整受绑定的 SSH 配置，应先复核配置，必要时撤销旧 Devices 记录，再明确重新授权，或新建一个 profile。

显示名称可变更；profile 名称、SSH 后端配置、主配置文件内容及预期身份参与绑定，不能悄悄将旧设备指向另一个目标。

## 4. 状态、失败处理与权限

状态位于 `~/.desktop-commander-device/profiles/<profile>/`，包含设备凭据、目标绑定、实例锁和调用日志。目录权限 0700，凭据及日志 0600；不得提交该目录到 Git，也不要复制一份设备凭据同时启动多个实例。

实例锁不根据系统时间的突然变化自动抢占。正常停止会释放锁；强制终止、掉电或未确认的清理可能留下 `instance.lock`。这时应先人工确认该 profile 的原进程已彻底退出，再只删除其残留锁目录。**不要在另一个实例仍可能运行时删锁，也不要把删锁命令放进自动重启脚本。** 该取舍避免云端校时使一个存活实例的锁被误判过期。

后端必须通过 MCP 初始化、完整工具列表与预期主机/用户检查，且该连接世代的目标绑定和 schema 复核通过，才能接收业务工具请求。断线立即撤销可用性；后台主动重连，不依赖下一次工具调用来触发恢复。心跳、Presence 和迟到的连接回调不能绕过后端可用性检查。

主机密钥不一致、目标身份改变、schema 改变、状态损坏等错误会停止，而不是无限尝试、接受新目标或退回 A 本地执行。网络中断和后端临时失效可以按退避策略重连。一次超时或断线并不证明远端操作已被撤销。

### 调用记录与结果缓存

每个调用在执行前持久记录意图。收到重复 call ID 不重复执行；进程重启后发现未完成意图，报告 `REMOTE_RESULT_UNKNOWN`。结果发送云端失败时只重传缓存结果，不重新执行工具。被云端确认的结果正文会从本地记录中删除，保留去重标记。

默认保留最多 10,000 条记录、总计 64 MiB、单次结果 8 MiB。达到容量上限时明确报错并停止接收新执行，不自动清除去重历史；大结果应使用工具分页。日志容量维护须结合云端旧调用保留策略人工审核，不能直接删掉记录后宣称旧调用仍保证不重复。

这不是跨服务绝对 exactly-once，也不能阻止调用方使用新 call ID 再次请求相同操作。文件和终端工具权限仍由 B 的账号决定。A 持有 SSH 访问能力和云端设备凭据；项目目录约定或工具黑名单不是操作系统级隔离。

SSH 主配置内容参与目标摘要，但 `Include` 的展开内容、系统级配置和外部密钥文件不是递归闭包。应使用专用、受控的 SSH 配置及已核验的主机密钥，避免配置被第三方修改。

## 5. 测试命令与验证范围

```sh
npm run test:ssh
npm run test:ssh:loopback
```

第一组测试使用真实 MCP SDK 和可控 stdio 子进程，验证错误配置、独立状态、令牌保存、断线、重复调用、结果重传、授权检查、健康监督及在线状态竞争。

第二组是显式选择运行的 Linux 集成测试：使用临时生成的 SSH 密钥和仅监听 `127.0.0.1` 的独立 sshd，启动普通 Desktop Commander 后端。它不访问现有 SSH 私钥、不会登记云端设备，也不会连接生产节点。为保持 OpenSSH StrictModes，临时授权文件位于当前账号家目录中新建的私有测试目录，测试结束后删除。它还要求已安装浏览器，避免上游普通后端启动时自动下载浏览器。缺少前提时测试会明确跳过。

真实回环测试用于验证标准输入输出传输、节点目录文件往返、命令执行、主机密钥拒绝、重连及短任务后端退出。**回环测试不能替代真实 A→B 网络、云端设备登记和 ChatGPT 工具选择验收。**

当前测试结果与未验证项记录在 `notes/SSH_DEVICE_TEST_REPORT.md`。开发机详细日志保存在 `.git/ssh-device-dev/evidence/`，不纳入源码发布。

## 6. 当前限制与正式验收前检查

B 的工具参数结构保持原样。绑定摘要只覆盖工具名称、输入/输出 schema 和 annotations；不包含可能嵌入当前 PID 的工具说明文字，否则正常后端重启会被误判为 schema 改变。工具说明本身仍原样返回。

已知旧进程 PID 和搜索会话在连接更替后拒绝继续使用，但当前上游工具只有数字 PID，无法为任意外部 PID 提供完整的跨重启身份保证。第一版不恢复旧交互终端。训练等长任务应在 B 用独立任务管理机制运行；断开 A 的 SSH 并不普遍保证 B 的所有脱离终端子进程都已结束。

本次开发以 Linux 为验证平台，示例启动器面向 POSIX 节点；Windows/Mac 的 A 端以及 Windows 节点不属于已验证范围。没有修改云端服务，也没有承诺云端 Tools schema 可以由客户端任意更新。

B 不需要为工具控制链连接官网，但普通后端仍可能读取功能开关、检查浏览器等。要求严格离线时，应另行验证出站限制、预装依赖及这些启动行为。

## 7. 上线与回滚

正式联调时需确认 A/B 身份、A→B 的 SSH 别名或命令、B 的 Node/后端/工作目录。凭据保留在机器上，不放入聊天、示例配置或 Git。先执行 doctor，核对输出确属 B，再执行 enroll；浏览器授权由账号所有者确认。

在原有本机设备继续在线的情况下单独启动 B 的 profile，验证 Devices 中 A/B 的 ID 不同，选择 B 后的 `hostname`、文件读写、进程和搜索操作确实落在 B。必须再验证 B 断线、A 断网、B 后端重启、云端撤销、重复请求及长时间令牌刷新；当前开发测试没有替代这些步骤。

回滚只需正常停止新增 profile 的服务或进程，撤销对应 Devices 记录，必要时删除该 profile 的本地凭据。原有本机 `remote` 实例不需要替换或重启。源码修改放在独立开发分支；尚未部署时不应通过 `git reset --hard` 丢弃用户现有工作区来“回滚”。

示例 user service 只作为文件交付，本次没有安装、启用或修改系统服务。生产安装应固定构建版本并审核权限，不把 `@latest` 当作可重复部署基线。

## 8. 与初始方案的差异

本次先交付独立 SSH profile 的代码、测试和命令行，不实现 GUI 节点管理器或单进程多节点管理。原有默认身份路径及本机执行类保持不变。

初始方案中的日志采用持久、原子 JSON 记录和有限结果缓存，而非新增数据库。实例锁优先防止存活实例重复执行，异常退出后需要确认并清理残留锁；没有宣称跨主机严格 exactly-once 或无条件自动恢复。

原设计文档保留不变，本文件说明实际落地实现；测试报告说明已经验证的范围，未经过真实节点和云端联调的项目不得视为完成验收。

## 9. 2026-09-18 真实 2202 节点联调更新

已完成 2202 的独立运行包部署、真实工具执行和重连验收，并修复真实节点暴露的 SSH EOF 后后端不退出问题。新增的启动选项和本次测试证据见 `SSH_DEVICE_2202_ACCEPTANCE.md`；前述早期“未部署/未联调”记录仅描述初次开发阶段。浏览器授权、Devices 独立设备选择及 ChatGPT 直接调用仍需后续确认，不从后台测试结果推定通过。
