<div align="center">
  <h1>🚀 ATK Agent</h1>
  <p><strong>AI-Powered Aerospace Mission Control</strong></p>
  <p>用自然语言驱动 ATK 航天仿真工具的 AI Agent</p>
  <p>
    <a href="#-快速开始"><img src="https://img.shields.io/badge/Quick_Start-blue?style=flat-square" alt="Quick Start"></a>
    <a href="#-功能特性"><img src="https://img.shields.io/badge/Features-green?style=flat-square" alt="Features"></a>
    <a href="#-架构"><img src="https://img.shields.io/badge/Architecture-orange?style=flat-square" alt="Architecture"></a>
    <a href="#-许可证"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="License"></a>
  </p>
</div>

---

## 📖 简介

**ATK Agent** 是一个基于大语言模型（LLM）的 AI Agent，通过 ATK 官方 CONNECT 模式直接控制 [ATK (Aerospace Tool Kit)](https://www.agi.com/products/stk) 进行航天任务仿真。

### 它能做什么？

| 能力 | 描述 |
|------|------|
| 🛰️ **卫星轨道设计** | Keplerian、Cartesian、SGP4、TLE 多种轨道设置 |
| 📡 **地面站管理** | 创建和管理地面站，计算覆盖范围 |
| 🎯 **机动规划** | 支持 Astrogator 机动规划 |
| 🔭 **敏感器配置** | 设置各类传感器参数 |
| 📊 **仿真运行** | 自动执行仿真并返回结果 |
| 💾 **场景管理** | 创建、保存、加载仿真场景 |

只需用**自然语言**描述你的需求，Agent 会自动调用 ATK 工具完成全部任务。

---

## ✨ 功能特性

- **🤖 自然语言交互** — 你说中文，它执行仿真，不需要学习 ATK 命令语法
- **🧠 基于 LLM 推理** — 支持 DeepSeek / Qwen / OpenAI 兼容接口
- **🔌 CONNECT 模式集成** — 基于 ATK 官方 Python 模块实现，稳定可靠
- **🔄 ReAct 循环架构** — 思考 → 行动 → 观察 → 验证，自动纠错
- **🪟 Windows 原生支持** — 自动启动 ATK.exe 并建立 TCP 连接
- **📦 零外部依赖** — 仅需 `requests` 一个 Python 包

---

## 🏗 架构

```
┌─ 用户 ─────────────────────────────┐
│  "创建一个场景，发射一颗轨道卫星"   │
└────────────────┬────────────────────┘
                 ↓
┌──────────────────────────────────────┐
│         ATK Agent (Python)           │
│                                      │
│  ┌──────────────────────────────┐   │
│  │  LLM 推理层                  │   │
│  │  · 理解自然语言需求           │   │
│  │  · 拆分任务步骤              │   │
│  │  · 生成 ATK 操作序列         │   │
│  └──────────┬───────────────────┘   │
│             ↓                        │
│  ┌──────────────────────────────┐   │
│  │  ATK 工具层 (ATKTools)       │   │
│  │  · create_scenario()         │   │
│  │  · create_satellite()        │   │
│  │  · set_orbit()               │   │
│  │  · create_facility()         │   │
│  │  · run_simulation()          │   │
│  │  · save_scenario()           │   │
│  └──────────┬───────────────────┘   │
│             ↓                        │
│  ┌──────────────────────────────┐   │
│  │  连接层 (ATKConnector)       │   │
│  │  · TCP Socket (:6655)        │   │
│  │  · atkOpen / atkConnect      │   │
│  │  · atkClose                  │   │
│  └──────────┬───────────────────┘   │
└─────────────┼────────────────────────┘
              ↓
┌──────────────────────┐
│      ATK.exe         │
│  (后台窗口运行)       │
└──────────────────────┘
```

---

## 🔧 快速开始

### 前置条件

- **ATK 4.0+** — 已安装并激活（[获取 ATK](https://www.agi.com/products/stk)）
- **Python 3.8+**
- **LLM API Key** — DeepSeek / OpenAI / 任意兼容接口

### 安装

```bash
# 1. 克隆仓库
git clone https://github.com/lihaichuan6686/atk-connect-agent.git
cd atk-connect-agent

# 2. 安装依赖
pip install -r requirements.txt

# 3. 配置
cp config.py.example config.py
# 编辑 config.py，填入 ATK 路径和 API Key

# 4. 测试连接
python atk_agent.py
```

### 配置说明

编辑 `config.py`，或通过环境变量配置：

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `ATK_EXE_PATH` | ATK.exe 路径 | `D:\atk-v4.0.0\...\ATK.exe` |
| `ATK_HOST` | ATK Connect 主机 | `127.0.0.1` |
| `ATK_PORT` | ATK Connect 端口 | `6655` |
| `LLM_API_KEY` | LLM API 密钥 | — |
| `LLM_MODEL` | 模型名称 | `deepseek-chat` |
| `LLM_BASE_URL` | API 地址 | `https://api.deepseek.com/v1` |
| `ATK_PYTHON_PATH` | ATK Python 模块路径 | 自动检测 |

### 使用示例

启动后直接输入自然语言指令：

```
> 创建一个名为 MyScenario 的场景，时间从 2022年11月5日 到 2022年11月8日
> 创建一颗名为 Sat1 的卫星，半长轴 7128.1km，倾角 98.4度
> 在北京 (39.9°N, 116.4°E) 创建一个地面站
> 运行仿真
> 保存场景
```

也可以作为 Python 库集成：

```python
from atk_agent import ATKAgent

agent = ATKAgent(api_key="sk-xxx", model="deepseek-chat")
agent.start_atk()
agent.connect_atk()

response = agent.chat("创建一个场景，包含一颗太阳同步轨道卫星")
print(response)

agent.stop_atk()
```

---

## 📁 项目结构

```
atk-connect-agent/
├── atk_agent.py            # 🧠 主 Agent（LLM 推理 + ReAct 循环）
├── atk_connector.py        # 🔌 ATK 连接层（TCP + 官方模块）
├── atk_tools.py            # 🛠  ATK 工具集（场景/卫星/地面站等）
├── config.py               # ⚙️  配置文件（被 .gitignore 排除）
├── config.py.example       # 📋 配置模板
├── requirements.txt        # 📦 Python 依赖
├── start.bat               # 🪟 Windows 启动脚本
└── test_deepseek.py        # 🧪 LLM API 测试脚本
```

---

## ⚠️ 注意事项

1. **ATK 路径** — 确保 `config.py` 中的路径指向你本地的 ATK.exe
2. **端口 6655** — ATK Connect 默认使用 TCP 6655 端口，确保未被占用
3. **时间格式** — 必须使用 ATK 格式：`"5 Nov 2022 00:00:00.000"`
4. **单位制** — 位置(米)、速度(米/秒)、角度(度)
5. **坐标系** — 默认使用 J2000 惯性坐标系
6. **API 密钥安全** — 优先通过环境变量 `LLM_API_KEY` 设置，避免硬编码

---

## 📄 许可证

本项目基于 **MIT License** 开源。详见 [LICENSE](LICENSE) 文件。

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

---

<div align="center">
  <sub>Built with ❤️ for the aerospace community</sub>
</div>
