# ATK Agent CLI 1.4.1

ATK Agent 是面向 ATK 4.0.0 的终端 Coding Agent。它提供带首次配置向导的 TUI、确定性 CLI 和标准 MCP Server，并通过每个 Session 独立的常驻 daemon 长期控制同一个 ATK 工程。

第一次使用请先读 [启动说明](./启动说明.md)。

## 1.4 核心能力

- React/Ink TUI、模型/API URL/API Key 向导、原创角色 Orbitling「小轨」
- DeepSeek、通义千问、OpenAI 兼容接口和 Ollama；API Key 使用 Windows DPAPI 加密
- 一个 Session 对应一个常驻 daemon 和一个长期运行的 Python sidecar，持续持有 CONNECT conId
- TUI、`run`、直调 CLI、MCP 客户端退出均不关闭 daemon、sidecar 或 ATK
- 严格绑定 ATK PID、启动时间、程序路径、CONNECT 端口和场景指纹，防止 PID 复用与错窗口操作
- 已绑定实例连接失败时返回 `ATTACH_FAILED`，绝不静默启动第二个 ATK
- 资源保护、建模前成本估算、批量操作进度、busy/cancelling/failed 状态和保守的 CONNECT bridge 取消/恢复
- sidecar 原生批量创建、轨道设置、位置读取、显示设置和 JSON/CSV 轨道目录导入
- 场景事务、检查点、回滚、保存策略与真正独立于 Session 目录的纯 ASCII 暂存
- 二维/三维模型/三维点/轨道/标签/颜色高级显示工具，以及对象导出后的真实属性读回
- 27 页官方离线 CONNECT 文档目录，216 个用法、61 个命令首词；未证实命令不会被猜测执行
- JSONL 事件、逐命令审计、ATK PID、场景指纹、开始/完成时间和资源快照

本产品只操作 ATK 及其官方接口，不提供任意 Shell 执行能力。

## 环境和安装

- Windows 10/11
- Node.js 22+
- ATK 4.0.0
- CPython 3.12（当前 ATK Python 模块已验证版本）

```powershell
git clone https://github.com/lihaichuan6686/atk-connect-agent.git
cd atk-connect-agent
npm.cmd install
npm.cmd run setup:python
npm.cmd run build
```

Python虚拟环境 .venv 位于本项目内部。若本机需要网络代理，请使用个人npm配置，不要把代理地址提交到仓库。

复制并核对 `.env.example` 中的 ATK 路径。关键配置示例：

```dotenv
ATK_EXE_PATH=D:\atk-v4.0.0\atk\ATK-v4.0.0-windows-x64\ATK-4.0.0\ATK.exe
ATK_PYTHON_PATH=D:\atk-v4.0.0\atk\ATK-v4.0.0-windows-x64\ATK-4.0.0\IntegratingWithATK\connect\Python
PYTHON_EXE=D:\atk-v4.0.0\atk-agent-cli\.venv\Scripts\python.exe
ATK_HOST=127.0.0.1
ATK_PORT=6655
```

## 启动 TUI

首次明确允许创建一个新 ATK：

```powershell
node .\bin\atk-agent.mjs chat --allow-new-atk
```

以后同一 Session 启动：

```powershell
node .\bin\atk-agent.mjs chat
```

默认 Session 为 `tui-main`，也可先设置 `ATK_AGENT_SESSION`。首次界面会要求选择服务商、API URL、API Key 和模型。`--allow-new-atk` 是显式授权；Session 已绑定 PID 时即使连接失败也不会创建新实例。

## 导演模式和实例管理

```powershell
node .\bin\atk-agent.mjs daemon start --session competition
node .\bin\atk-agent.mjs daemon status --session competition
node .\bin\atk-agent.mjs instance list
node .\bin\atk-agent.mjs instance attach --pid 33436 --session competition
node .\bin\atk-agent.mjs instance current --session competition
node .\bin\atk-agent.mjs instance detach --session competition
node .\bin\atk-agent.mjs daemon stop --session competition
```

`daemon stop` 默认保留 ATK。只有 `daemon stop --close-atk` 或 `session close` 才会尝试关闭，并且仅关闭身份和归属都验证通过的实例。检测到未绑定 ATK 时必须显式 attach；多个实例会全部列出并要求选择。

daemon 与后续 CLI 必须保持相同的 Windows 权限级别。如果记录中的 daemon PID 和锁仍然存活、但当前进程无法访问命名管道，CLI 会返回 `DAEMON_PERMISSION_MISMATCH`，不会尝试启动第二个 daemon。

## 确定性工具调用

```powershell
node .\bin\atk-agent.mjs tool list
node .\bin\atk-agent.mjs tool call ensure_scenario --session competition --allow-new-atk --json-args '{"name":"Demo"}' --timeout 120000
node .\bin\atk-agent.mjs tool call get_atk_runtime_state --session competition --json-args '{}'
```

建模前先估算：

```powershell
node .\bin\atk-agent.mjs tool call estimate_scene_cost --session competition --json-args '{"object_count":597,"duration_seconds":31536000,"step_seconds":1800}'
node .\bin\atk-agent.mjs tool call check_resource_budget --session competition --json-args '{"object_count":597,"estimated_ephemeris_points":10460037}'
```

长任务状态、取消与恢复：

```powershell
node .\bin\atk-agent.mjs operation status --session competition
node .\bin\atk-agent.mjs operation cancel --session competition
node .\bin\atk-agent.mjs operation wait --session competition --timeout 60000
node .\bin\atk-agent.mjs operation wait --session competition --recover --timeout 60000
```

客户端超时不等于 ATK 运算终止。取消会中断 sidecar 连接并把 Session 标为 failed；只有探测确认 ATK 可重新连接后，`--recover` 才恢复 idle。ATK 4.0 官方 CONNECT 没有通用的“确认内部计算已停止”接口，因此产品不会虚报终止成功。

## 批量、事务和保存

主要工具：`begin_scene_transaction`、`commit_scene_transaction`、`rollback_scene_transaction`、`batch_create_satellites`、`batch_set_satellite_classical`、`batch_get_positions`、`batch_set_graphics`、`import_orbit_catalog`、`save_scenario_with_policy`、`load_scenario_unicode_safe`。

保存策略为 `never`、`checkpoint`、`overwrite`、`save_as`、`autosave`。覆盖、恢复和加载等破坏性操作必须显式传入 `--allow-destructive`。

所有交给 ATK 的保存、加载、对象导出和事务文件路径都会先进入纯 ASCII 临时目录，再由 Node 复制回中文目标目录。可用 `ATK_AGENT_ASCII_TEMP` 指定该目录；它必须是纯 ASCII 的绝对路径。原始 CONNECT 文件命令同样拒绝中文和相对路径，避免绕过保护。

## 三维显示与验证

高级工具：`set_object_visibility`、`set_point_cloud_display`、`set_orbit_display`、`set_label_display`、`set_3d_model_display`、`color_objects_by_attribute`、`verify_object_display_state`、`get_visualization_capabilities`。

`verify_object_display_state` 会导出对象临时副本，读回 `ShowModel`、`ShowPoint`、`PointSize`、二维显示、标签、轨道和颜色，并用 `Position` 检查当前时刻是否有有效位置。

ATK 4.0 离线官方 CONNECT 文档没有相机包围盒、裁剪状态或可靠的 fit-all 相机接口。本版本明确返回该限制，不会把命令 `OK` 伪装成“相机中一定可见”。真正的单对象轻量点云也未在官方 CONNECT 中提供；总体目录应通过短时间窗、大步长和候选升级策略控制资源。

## ATK实时展示 Skill

仓库内置项目级技能 [`atk-live-visualization`](./.agents/skills/atk-live-visualization/SKILL.md)。支持项目技能的AI进入本仓库后，可以自动获得一套经过ATK 4.0实机验证的展示流程，包括：

- 识别并绑定正确的ATK进程和Session；
- 建模前估算对象数、星历点数、内存和显存风险；
- 创建对象后强制读取非零位置，不把CONNECT `OK`误判为传播成功；
- 为航天器、碎片设置三维点、轨道、颜色、标签和模型显示；
- 加载中文路径场景和外部星历时使用纯ASCII暂存；
- 排查“只有地球”“只有地面投影”“位置速度为0”“红线遮住碎片轨迹”等问题；
- 重置并播放动画、确认时钟推进，最终保持ATK窗口打开供用户检查。

外部轨道优化器生成的拼接转移轨迹，请同时阅读技能中的 [`external-ephemeris.md`](./.agents/skills/atk-live-visualization/references/external-ephemeris.md)。

## 单次 Agent 和 MCP

```powershell
node .\bin\atk-agent.mjs run "读取当前 ATK 状态" --session competition --timeout 600000
node .\bin\atk-agent.mjs run "创建一个测试场景" --json --session competition --allow-new-atk --timeout 600000
node .\bin\atk-agent.mjs mcp --transport stdio --session competition
```

MCP 默认不允许新建 ATK 或破坏性操作。必须由操作者明确设置 `ATK_MCP_ALLOW_NEW_ATK=1` 或 `ATK_MCP_ALLOW_DESTRUCTIVE=1`。

## 默认资源硬限制

```json
{
  "maxAtkMemoryGB": 6,
  "minSystemFreeMemoryGB": 4,
  "maxGpuMemoryPercent": 80,
  "maxObjectCount": 1000,
  "maxEstimatedEphemerisPoints": 2000000
}
```

达到 80% 时警告，达到硬限制时拒绝继续。可通过 `.env.example` 中对应变量调整。

## 验证、数据和退出码

```powershell
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd run smoke:atk:catalog
```

当前自动测试覆盖纯 ASCII 暂存、中文数据根下的保存/加载/显示导出、原始 CONNECT 路径拦截，以及 Windows daemon 权限错配。需要真实 ATK 的验收应在与比赛运行相同的 Windows 权限级别下执行。

退出码：`0` 成功，`1` 内部错误，`2` 输入/配置错误，`3` daemon/附着失败，`4` CONNECT 失败，`5` Agent 步数上限，`6` 超时/取消，`7` 读回验证失败，`8` Session busy，`9` 资源限制。

Session 数据默认位于 `.atk-agent\sessions\<id>`，包含 `manifest.json`、`events.jsonl`、`commands.jsonl`、`daemon.log`、`artifacts` 和 `checkpoints`。
