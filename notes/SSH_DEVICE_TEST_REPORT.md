# SSH-backed Devices：开发测试报告

日期：2026-09-18。开发基线：`092ce0b841e86455f12e41f4dc36399a7522ecb5`。
开发分支：`feature/ssh-backed-devices`。本报告对应该分支的未提交工作区；没有推送、合并 main 或正式部署。

## 结论

SSH profile 的核心实现已经通过 TypeScript/资源构建、29 项新增自动化测试、1 项真实 OpenSSH 回环集成测试，以及 7 个原有相关回归脚本。真实回环不是模拟 SSH：使用临时密钥、独立 sshd 和普通 Desktop Commander 后端，并验证文件/命令及重连后的行为。

**真实 A→B 服务器、官网独立设备登记、ChatGPT 选择 B 的完整链路尚未联调。因此这份报告不是生产可用性或云端兼容性的最终验收。** 未运行整个上游测试集合，也未验证 Windows/Mac 或多节点生产环境。

## 最终结果

| 项目 | 结果 | 证据文件（相对 `.git/ssh-device-dev/evidence/`） |
|---|---|---|
| `npm run build` | 退出码 0 | `final-build.log` |
| 新增单元/协议/CLI 测试 | 29 通过，0 失败，0 跳过；约 11.8 秒 | `final-ssh-tests.log` |
| 真实 OpenSSH 回环 | 1 通过，0 失败，0 跳过；约 5.4 秒 | `final-loopback-tests.log` |
| sshd 回环日志 | 测试后清理临时实例与密钥 | `final-loopback-sshd.log` |
| 原有相关回归 | 下列 7 个脚本均退出 0 | `final-<脚本名>.log` |
| `git diff --check` | 退出码 0 | 开发过程终端核验 |

构建环境：Linux x86_64、Node.js v24.14.0；项目 0.2.51，锁定 MCP SDK 1.25.1。系统默认 Node.js 未更改。依赖通过锁文件安装且未增加依赖包或修改锁文件。

## 原有回归脚本

```text
test-remote-channel-reconnect.js
test-remote-channel-signed-out.js
test-remote-clock-skew-before-session.js
test-remote-inflight-call-fast-fail.js
test-remote-token-rotation-persisted.js
test-remote-transport.js
test-strip-null-bytes.js
```

上述脚本在修改前建立基线，修改后再次全部通过。测试使用独立 HOME，不复用当前设备的云端凭据。

## 已验证的关键行为

配置拼写错误不会进入本机回退；SSH 启动参数固定且正确引用路径；身份错误、主机密钥不一致、畸形 stdout、缺失工具、超时和身份状态损坏均被拒绝。独立 profile 不覆盖默认设备状态，跨进程锁能阻止重复实例，校时不会使存活实例的锁被抢占。

后端重连必须完成目标和调用 schema 校验后才能执行业务请求。工具说明中动态 PID 不参与 schema 摘要，正常重启不应误报结构变化。真实后端经过一次重连后 schema 一致且仍可读回文件。

重复 call ID、断线前可能已经执行的写入、重启后未完成的意图不会自动重放。云端结果发送失败只重传缓存；容量不足、损坏日志或授权检查失败不执行新的工具操作。已知旧 PID/搜索会话被拒绝继续使用。

健康监督主动重连，不等调用触发；迟到的 Presence 成功消息不能将已失效节点重新标为可用。停止期间未完成的握手不能恢复业务路由。

真实 SSH 集成断开时，测试中的普通后端退出得到验证。这不证明所有生产长任务或脱离会话的子进程都会退出。

## 开发中发现并修正的问题

最初回环 sshd 因 `/tmp` 祖先目录的权限拒绝临时授权文件。修正为账号家目录下的私有临时目录，保留 `StrictModes yes`；没有放宽系统 SSH 配置。早期失败及修复后的日志均保留，最终测试通过。

锁定的 MCP SDK 在传输断开时会拒绝请求，但部分请求计时器仍保留到超时。新增层通过 SDK 的公开 AbortSignal 接口清理这些请求，未修改依赖源码；22 项早期用例的进程总时长从约 64 秒降为约 9 秒。最终扩展为 29 项并全部通过。

真实工具说明包含运行时 PID。schema 绑定改为比较可调用结构而不是整段动态说明，并加入单元测试与真实后端重启检查，避免正常重连被错误拒绝。

## 保持不变的基线

`main` 仍指向 `092ce0b841e86455f12e41f4dc36399a7522ecb5`。

`package-lock.json` SHA-256：
`fc26ee3aef7bc01b6cc3898e59c85a6a11f8fc41ba3c77d943b10b53822e434c`

原始技术方案 SHA-256：
`59e55311c002a2265e3465368cf0c5a86851c20511461565930ead163fa09a06`

现有本机设备的 `device.ts`、`desktop-commander-integration.ts` 未修改；未停止已有连接，未修改系统默认 Node、现有 SSH 配置或已授权设备凭据。临时回环目录在测试结束后已清理。

## 下一阶段仍需验收

需要实际 A→B SSH 目标、B 的可用后端/运行环境和账号所有者的浏览器授权。尚未完成真实云端新增设备、ChatGPT 选中 B 后的工具调用、长期令牌刷新及撤销传播时间、复杂网络/跳板机和长任务生命周期验证。实例异常退出残留锁、日志容量、未知外部 PID 和严格离线行为的限制见实现说明。
