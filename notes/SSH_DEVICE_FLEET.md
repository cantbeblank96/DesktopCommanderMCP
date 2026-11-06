# SSH 节点批量接入与自动巡检

## 目标与入口

在 A 上读取已批准的 `check_cloud_gpu.sh` 节点清单，为可达但尚未登记的节点准备独立后端与配置。首次登记仍通过官网设备授权，成功后自动运行；暂时离线的节点定期重试。

实现为独立 Python 标准库脚本，不重新实现已有的 SSH/MCP 后端：

- `scripts/ssh-fleet.py`：命令行与后台巡检。
- `scripts/ssh_fleet_lib.py`：清单校验、探测、部署、云端去重、进程及授权页面。
- `test/test_ssh_fleet.py`：无需网络和真实凭据的测试。

原有 A 与已运行的 2202 不会被覆盖或重复启动。云端状态通过已授权 profile 的现存 access token 只读查询；不刷新其会话、不复制其设备身份、不用它替其他节点完成授权。云端清单查询失败时不新增设备。

## 当前机器上的命令

在 A 的终端执行，无需切换系统 Node.js：

```sh
$HOME/.config/rdc-ssh/fleet/manage.sh scan
$HOME/.config/rdc-ssh/fleet/manage.sh sync
$HOME/.config/rdc-ssh/fleet/manage.sh start-watch
$HOME/.config/rdc-ssh/fleet/manage.sh status
$HOME/.config/rdc-ssh/fleet/manage.sh dashboard
```

`scan` 只读检查；`sync` 为可达节点部署并自检，但不为新节点发起授权；`start-watch` 在后台每 120 秒检查一次，为准备好的新节点发起一次授权，并维护已经授权的连接。`status` 显示带时间戳的最近网络/云端检查和当前进程状态。

使用 `start-watch --registered-only` 可保留清单探测，并仅恢复同时具备本地 profile、凭据和云端设备记录的节点。可达的未登记节点会显示 `UNREGISTERED_SKIPPED`，等待人工部署和授权。切换已有巡检的模式时，先执行 `stop-watch`，再用所需参数启动巡检。

## 一次性设备授权

授权码是官网设备绑定流程的短期确认码，不是日常密码。带验证码的完整链接会直接打开确认页，通常不需要再次手工输入。请核对设备名称，只确认本人发起的节点。授权完成后无需保存该码。

每个新节点使用自己的独立授权记录；不能仅凭 SSH 可以连接就绕过官网授权。新节点的确认页可能自动在 A 的浏览器打开，所有待确认链接也集中在：

```text
$HOME/.local/state/rdc-ssh-fleet/cci/authorizations.html
```

授权页每 15 秒自动刷新。授权成功后节点连接自动继续运行。一次授权过期后不会每轮巡检重复弹窗；需要人工明确重新发起：

```sh
$HOME/.config/rdc-ssh/fleet/manage.sh authorize --ports 2702 2802 2803
```

上面端口仅为示例，必须是已批准清单中的节点。已加入 Devices 的节点会被跳过，已撤销的设备不会被静默重新登记。

## 停止与持久运行

```sh
# 只停自动检测，不停已有的设备连接
$HOME/.config/rdc-ssh/fleet/manage.sh stop-watch
# 只停止本批量脚本创建并记录的指定节点进程，不操作原 A/外部启动的 2202
$HOME/.config/rdc-ssh/fleet/manage.sh stop-workers --ports 2702
```

停止 worker 后保留人工停止标记，不会在下一轮被自动重启。重新启动需通过显式操作清除停止标记；不应直接删除 profile 的实例锁来强行启动。

```sh
# 明确恢复被人工停止的节点；不会自动重做设备授权
$HOME/.config/rdc-ssh/fleet/manage.sh resume --ports 2702
```

后台巡检是 A 上实际运行的进程，不是 ChatGPT 在后台等待。它没有被安装成开机自启服务；A 重启后需要重新启动。强制终止 profile 后可能遗留锁，仍按单节点说明先核验原进程退出，不自动删锁。若云端锚点 2202 尚未恢复运行或授权失效，先恢复它，再启动批量巡检。

## 范围与安全边界

只读取 shell 文件里的字面量 HOST/PORTS 默认值，不执行、不 source 该文件；清单 SHA-256 在私有配置中固定。修改清单后需人工复核并更新摘要，避免把一个项目文件的变化默认为允许接管新机器。默认清单是 2201、2202、2209、2702、2801、2802、2803。

SSH 只使用已有密钥路径，严格核验既有主机公钥；不会读取或复制私钥正文，不关闭主机校验。遇到新的未知公钥、旧公钥冲突、节点 hostname 改变、云端设备被撤销或本地状态损坏时，不自动接受新身份或静默重建设备。

沿用清单中的 root 账号意味着工具具有 root 权限；私有工作区不构成权限沙箱。没有执行 GPU 任务，没有修改服务器系统库、系统 SSH 服务、全局 PATH 或原巡检脚本。

运行包只包含专用 Node、搜索程序、应用与依赖。上传后核对 SHA-256，在节点专用目录展开，不运行 npm 安装脚本。旧系统节点采用独立的静态 musl ripgrep；没有通过升级 glibc 解决兼容性。B 的普通后端启用 stdin 关闭退出和跳过浏览器启动预检查。

私有配置位于 `$HOME/.config/rdc-ssh/`，授权与 profile 锁位于 `$HOME/.desktop-commander-device/profiles/`，批量状态及日志位于 `$HOME/.local/state/rdc-ssh-fleet/cci/`；都不应提交到 Git。授权记录中含令牌，日志中可能出现短期授权链接，禁止公开。

## 测试

```sh
python3 -m unittest discover -s test -p test_ssh_fleet.py -v
```

覆盖清单不被执行、目标限制、主机检查、凭据隔离、去重、撤销、离线、授权不过度重试、锁、PID 重用与报告转义。真实节点另外执行 `test/integration/test-ssh-backed-target.js` 的显式授权临时目录测试；不会用“doctor 成功”替代文件/搜索实测或浏览器设备授权。

## 部署完成不等于已加入 Devices

官网 Devices 列表不是“待授权申请”列表。只有 `sync` 成功时，网页不会出现新节点，也不会出现确认按钮。这时应显式运行 `authorize --ports ...`，再打开输出/日志中的专属确认链接；也可运行 `dashboard` 打开本地汇总页。不要为了寻找确认入口而撤销已有设备。

仅在浏览器授权成功并且连接进程开始运行之后，新节点才会成为账号下的可用设备。代码提交、Git 推送和网页设备授权是三个独立操作。

新环境的完整配置字段见 `examples/ssh-device/fleet.example.json`。将示例复制到仓库外的私有目录，修改绝对路径，填入核验后的清单与运行包 SHA-256；`RELEASE`、校验值和用户目录均为占位符，不能直接用于运行。源文件里的 HOST/PORTS 必须符合本脚本支持的字面量默认值格式。

2803 初始化时的局部/重复输出问题已修复并增加回归测试。已更新的连接端按完整尾部快照解析主机信息，不放松身份校验。实际运行仍需切换到包含该修复的 A 端构建；只拉取源码不会自动替换此前的固定运行包。
