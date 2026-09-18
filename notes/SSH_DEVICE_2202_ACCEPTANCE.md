# 2202 节点：真实 SSH 接入验收记录

日期：2026-09-18。连接机 A：`cn3114000858l`。目标 profile：`cci-2202`。

**后续更新：2202 已完成官网独立设备授权，已通过 ChatGPT 选中该设备执行 hostname、用户及工作目录检查。以下保留首次部署时的历史记录；当前代码交付状态以 `SSH_DEVICE_RELEASE_STATUS.md` 为准。**

**状态：真实 A→B 工具执行链已通过验证；云端新设备授权仍需账号所有者在浏览器确认。未将该结果当作 Devices/ChatGPT 完整端到端验收通过。**

## 1. 连接与部署

连接参数来自用户指定的 `kevin_score/scripts/cloud/check_cloud_gpu.sh`；只访问 2202，没有执行整份 GPU 巡检脚本。沿用已有 SSH 密钥与 root 账号，但使用 A 既有 known_hosts 中的主机密钥记录进行严格验证，没有沿用原巡检脚本的 `StrictHostKeyChecking=no`。

B 原先没有 Node.js。已在专用目录部署 Node.js 24.14.0、ripgrep、固定依赖和普通 Desktop Commander 后端；没有安装系统包、修改全局 PATH 或启动 GPU 任务。B 的应用 HOME/工作目录与业务目录分开。

A 与 B 当前固定构建：`20260918T103956Z-ecccb9d24538`。部署时核对基础运行包、修复增量包的 SHA-256，以及 257 个编译/配置文件的摘要。源代码仍在开发分支工作区，未提交或推送。

| 内容 | 位置 |
|---|---|
| A 私有配置 | `$HOME/.config/rdc-ssh/cci-2202/` |
| A 固定运行包 | `$HOME/.local/share/rdc-ssh/bridge-builds/20260918T103956Z-ecccb9d24538/` |
| B 专用目录 | `/root/.local/share/rdc-ssh/cci-2202/` |
| B 固定运行包 | 上述目录的 `releases/20260918T103956Z-ecccb9d24538/` |
| B 启动器 | 上述目录的 `rdc-stdio.sh` |
| B 应用配置与工作区 | 上述目录的 `state-home/`、`workspace/` |

私钥仍保留在 A；真实 SSH 配置、云端凭据和授权链接不纳入源码发布。沿用 root 意味着工具拥有该账号的权限，不构成安全沙箱。

## 2. 实际测试结果

35 项单元、协议、CLI 和新增生命周期测试全部通过。针对真实 2202 的集成测试通过；A 上固定运行包的 doctor 也通过，识别到 B 的正确主机名、root 用户和 26 个工具。

真实节点测试覆盖：文件写入与读回、精确编辑、命令执行、内容搜索、独立 SSH 回读、A 上不存在同名测试文件、断线后的重新连接、两代后端进程退出、临时文件清理。测试目录使用 B 的 `/tmp/rdc-accept-<随机标记>`，没有修改业务文件。

26 是工具目录的数量，不表示已逐一验证所有 26 个工具。GPU 训练、PDF 浏览器功能、跨天运行、令牌轮换、云端撤销、网页状态与 ChatGPT 实际选择设备等不能由此次结果推定通过。

## 3. 真实节点暴露的问题与修复

第一次实际节点测试发现：搜索等操作之后，SSH 标准输入关闭没有使后端退出，残留 Node 进程被重新挂到 PID 1。此时文件/编辑/搜索已成功，但退出检查失败；原始失败日志保留，未覆盖成成功记录。

新增显式启用的 `DESKTOP_COMMANDER_EXIT_ON_STDIN_CLOSE=1`。仅对需要该行为的普通 stdio 后端安装 EOF/close/SIGTERM/SIGHUP 退出处理，关闭 MCP 并设置退出期限。原有默认行为与 A 的原设备实例不被替换。新增单元测试覆盖默认禁用、重复事件、超时、关闭失败，以及真实子进程仍有定时器时的 EOF 退出。

此前唯一残留的测试后端是在核验其专用可执行文件路径与进程启动时间后终止的，已确认被回收。修复后的真实节点测试确认两代后端均退出。此证明不涵盖用户自行脱离终端的后台作业或任意子孙进程树。

另外增加 `DESKTOP_COMMANDER_SKIP_CHROME_PREFLIGHT=1`，避免 headless 节点在启动时自动检查/下载浏览器；显式调用 PDF 生成仍走原有浏览器处理路径。这不是严格零出站网络模式。

## 4. 证据文件

详细日志保存在开发仓库的 `.git/ssh-device-dev/evidence/`，不纳入 Git 发布：

```text
2202-target-acceptance.log          # 原始退出检查失败
2202-target-acceptance-v2.log       # 修复后实际节点通过
2202-eof-and-ssh-tests.log          # 35 项测试通过
2202-frozen-doctor.log             # A/B 固定构建自检通过
```

8 个原有远程连接及浏览器缓存相关回归脚本也全部通过，记录见 `2202-regression.log`。没有将针对性测试说成整个上游测试集合全部通过。

## 5. 授权与启动

以下命令在 A 执行，使用独立的固定构建，不使用系统默认 Node.js：

```sh
# 无云端登记的检查
$HOME/.config/rdc-ssh/cci-2202/manage.sh doctor

# 发起独立设备授权；用户在浏览器确认后，当前进程自动进入服务模式
$HOME/.config/rdc-ssh/cci-2202/manage.sh authorize-and-start

# 已经完成授权、原连接进程停止后，恢复同一个设备
$HOME/.config/rdc-ssh/cci-2202/manage.sh serve
```

预计展示名为 `cci-2202 (via cn3114000858l)`。不要重复启动同一 profile；运行时的独立实例锁会阻止第二个实例。当前未安装或启用 systemd 常驻服务。

授权成功后的下一项验收是：原 A 仍在线、B 的设备 ID 独立、在 ChatGPT 中指定 B 执行主机名检查和临时文件往返。浏览器确认之前不能声称已完成此项。

节点 Pod 重建后 hostname/SSH 主机密钥可能变化。连接器会拒绝未经确认的身份变化，需要复核并更新绑定；不会自动接受变化后的目标。长任务应明确独立托管，本后端退出处理不是全系统进程清理器。
