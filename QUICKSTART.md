# ATK Agent 快速开始

## 项目结构

```
atk_agent/
├── atk_agent.py      # 主 Agent（LLM 推理 + 工具调用）
├── atk_connector.py  # ATK 连接层（TCP Socket）
├── atk_tools.py      # ATK 工具集（场景、卫星、地面站等）
├── config.py         # 配置文件
├── requirements.txt  # Python 依赖
├── test_connection.py# 测试脚本
├── .gitignore        # Git 忽略文件
└── README.md         # 项目文档
```

## 快速开始

### 1. 安装依赖

```bash
cd D:\2025frb\atk_agent
pip install -r requirements.txt
```

### 2. 配置 ATK 路径

编辑 `config.py`，确认 ATK 路径正确：

```python
ATK_EXE_PATH = r"D:\atk-v4.0.0\atk\ATK-v4.0.0-windows-x64\ATK-4.0.0\ATK.exe"
```

### 3. 测试连接

```bash
python test_connection.py
```

如果看到 `🎉 ATK 连接测试通过！`，说明连接正常。

### 4. 启动 Agent

```bash
python atk_agent.py
```

然后输入自然语言指令，例如：

```
你: 创建一个名为 MyScenario 的场景，时间从 2022年11月5日 到 2022年11月8日
你: 创建一颗名为 Sat1 的卫星，半长轴 7128.1km，倾角 98.4度
```

## 注意事项

1. **ATK 必须先安装** - 确保 ATK 2.0 已安装并激活
2. **端口 6655** - ATK Connect 默认使用 TCP 6655 端口
3. **时间格式** - 必须使用 ATK 格式，如 `"5 Nov 2022 00:00:00.000"`
4. **单位** - 位置(米)、速度(m/sec)、角度(度)

## 常见问题

### Q: ATK 启动失败？

A: 检查 `config.py` 中的 `ATK_EXE_PATH` 是否正确。

### Q: 连接失败？

A: 确保 ATK 正在运行，并且端口 6655 未被占用。

### Q: 命令执行失败？

A: 检查命令参数格式是否正确，参考 ATK 官方文档。

## 参考文档

- [ATK 官方文档](atk-doc-offline/)
- [CONNECT模式文档](atk-doc-offline/二次开发教程/1-二次开发CONNECT模式/)
