"""
ATK Agent - AI Agent for ATK Control
基于 ATK 官方 CONNECT模式文档实现

功能：
1. 自动启动 ATK.exe
2. 通过 LLM (DeepSeek) 理解用户需求
3. 调用 ATKTools 操作 ATK（ReAct 循环：思考→行动→观察→验证）
4. 返回结果

参考文档：
- 二次开发教程/2-二次开发CONNECT模式/
- 二次开发教程/2-二次开发CONNECT模式/6-Python客户端/2-举例.html
"""
import os
import sys
import json
import time
import requests
from typing import Optional, Dict, Any, List

from config import ATK_EXE_PATH, ATK_HOST, ATK_PORT, ATK_STARTUP_WAIT, OUTPUT_DIR, LLM_API_KEY, LLM_MODEL, LLM_API_URL
from atk_connector import ATKConnector, ATKProcess
from atk_tools import ATKTools


class ATKAgent:
    """
    ATK AI Agent
    
    架构：
    用户自然语言 → DeepSeek LLM → ATKTools → ATK Connect → ATK.exe
    
    ReAct 循环：
    思考(Think) → 行动(Act) → 观察(Observed) → 验证(Verify) → 继续/完成
    """
    
    def __init__(self, api_key: str = "", model: str = ""):
        self.api_key = api_key or LLM_API_KEY
        self.model = model or LLM_MODEL
        self.api_url = LLM_API_URL
        self.atk_process: Optional[ATKProcess] = None
        self.connector: Optional[ATKConnector] = None
        self.tools: Optional[ATKTools] = None
        self.conversation_history: List[Dict[str, str]] = []
        
        # 确保输出目录存在
        os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    def start_atk(self) -> bool:
        """
        启动 ATK
        
        Returns:
            bool: 启动是否成功
        """
        print(f"[ATK Agent] 正在启动 ATK...")
        print(f"[ATK Agent] ATK 路径: {ATK_EXE_PATH}")
        
        self.atk_process = ATKProcess(ATK_EXE_PATH)
        success = self.atk_process.start(wait_seconds=ATK_STARTUP_WAIT)
        
        if not success:
            print("[ATK Agent] ATK 启动失败")
            return False
        
        print("[ATK Agent] ATK 已启动，正在连接...")
        return True
    
    def connect_atk(self) -> bool:
        """
        连接到 ATK
        
        Returns:
            bool: 连接是否成功
        """
        self.connector = ATKConnector(ATK_HOST, ATK_PORT)
        success = self.connector.connect()
        
        if not success:
            print("[ATK Agent] ATK 连接失败")
            return False
        
        print("[ATK Agent] ATK 连接成功")
        self.tools = ATKTools(self.connector)
        return True
    
    def stop_atk(self):
        """关闭 ATK"""
        if self.connector:
            self.connector.close()
        if self.atk_process:
            self.atk_process.stop()
    
    # ===== LLM 推理 =====
    
    def call_llm(self, messages: List[Dict[str, str]], 
                 tools: Optional[List[Dict]] = None) -> Dict[str, Any]:
        """
        调用 DeepSeek LLM
        
        参数:
            messages: 对话消息列表
            tools: 工具定义列表
        
        Returns:
            dict: LLM 响应
        """
        url = self.api_url
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 4096
        }
        
        if tools:
            payload["tools"] = tools
        
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=60)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"[LLM] 调用失败: {e}")
            return {"error": str(e)}
    
    def get_tools_definition(self) -> List[Dict]:
        """
        获取 ATK 工具定义（给 LLM 调用）
        
        Returns:
            list: 工具定义列表
        """
        return [
            {
                "type": "function",
                "function": {
                    "name": "create_scenario",
                    "description": "创建 ATK 仿真场景。**中心天体必须在此步骤指定！**",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "场景名称（必须使用英文，如 'MyScenario'）"},
                            "start_time": {"type": "string", "description": "开始时间，格式: '5 Nov 2022 00:00:00.000'"},
                            "end_time": {"type": "string", "description": "结束时间"},
                            "step_seconds": {"type": "number", "description": "仿真步长(秒)", "default": 60},
                            "central_body": {"type": "string", "description": "中心天体（Earth/Moon/Mars/Sun）。月球场景必须设为 'Moon'，火星场景必须设为 'Mars'。默认 'Earth'", "enum": ["Earth", "Moon", "Mars", "Sun"]}
                        },
                        "required": ["name", "start_time", "end_time"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "create_satellite",
                    "description": "创建卫星对象",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "卫星名称（必须使用英文，如 'LEOSat'）"}
                        },
                        "required": ["name"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "set_satellite_classical",
                    "description": "设置卫星轨道参数（轨道根数模式）",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "卫星名称"},
                            "propagator": {"type": "string", "enum": ["TwoBody", "J2Perturbation", "J4Perturbation", "HPOP", "LOP"], "description": "轨道预报器"},
                            "start_time": {"type": "string", "description": "开始时间"},
                            "end_time": {"type": "string", "description": "结束时间"},
                            "step_seconds": {"type": "number", "description": "步长(秒)"},
                            "coord_system": {"type": "string", "description": "坐标系(J2000或Fixed)"},
                            "orbit_epoch": {"type": "string", "description": "轨道历元"},
                            "sma": {"type": "number", "description": "半长轴(米)"},
                            "ecc": {"type": "number", "description": "偏心率(0~1)"},
                            "inc": {"type": "number", "description": "轨道倾角(度)"},
                            "argp": {"type": "number", "description": "近地点角(度)"},
                            "raan": {"type": "number", "description": "升交点赤经(度)"},
                            "ma": {"type": "number", "description": "平近点角(度)"}
                        },
                        "required": ["name", "propagator", "start_time", "end_time", "step_seconds", "coord_system", "orbit_epoch", "sma", "ecc", "inc", "argp", "raan", "ma"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "set_satellite_cartesian",
                    "description": "设置卫星轨道参数（位置速度模式）",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "卫星名称"},
                            "propagator": {"type": "string", "enum": ["TwoBody", "J2Perturbation", "J4Perturbation", "HPOP", "LOP"], "description": "轨道预报器"},
                            "start_time": {"type": "string", "description": "开始时间"},
                            "end_time": {"type": "string", "description": "结束时间"},
                            "step_seconds": {"type": "number", "description": "步长(秒)"},
                            "coord_system": {"type": "string", "description": "坐标系"},
                            "orbit_epoch": {"type": "string", "description": "轨道历元"},
                            "x": {"type": "number", "description": "X位置(米)"},
                            "y": {"type": "number", "description": "Y位置(米)"},
                            "z": {"type": "number", "description": "Z位置(米)"},
                            "vx": {"type": "number", "description": "X速度(m/sec)"},
                            "vy": {"type": "number", "description": "Y速度(m/sec)"},
                            "vz": {"type": "number", "description": "Z速度(m/sec)"}
                        },
                        "required": ["name", "propagator", "start_time", "end_time", "step_seconds", "coord_system", "orbit_epoch", "x", "y", "z", "vx", "vy", "vz"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "create_facility",
                    "description": "创建地面站",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "地面站名称（必须使用英文，如 'BeijingGS'）"},
                            "lat": {"type": "number", "description": "纬度(度)"},
                            "lon": {"type": "number", "description": "经度(度)"},
                            "alt_km": {"type": "number", "description": "海拔(km)", "default": 0}
                        },
                        "required": ["name", "lat", "lon"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "set_central_body",
                    "description": "设置场景的中心天体（地球、月球、火星等）。如果要创建月球/火星为中心的场景，必须先调用此工具！",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "天体名称（Earth, Moon, Mars, Sun 等）"},
                            "body_type": {"type": "string", "description": "天体类型", "default": "CentralBody"}
                        },
                        "required": ["name"]
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "run_simulation",
                    "description": "运行仿真（播放动画）",
                    "parameters": {
                        "type": "object",
                        "properties": {}
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "save_scenario",
                    "description": "保存场景到文件",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "filepath": {"type": "string", "description": "保存路径(.xml文件)"}
                        }
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "get_satellite_position",
                    "description": "获取卫星当前位置和速度",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "卫星名称"},
                            "time": {"type": "string", "description": "时间(可选)"}
                        },
                        "required": ["name"]
                    }
                }
            }
        ]
    
    def execute_tool(self, tool_name: str, arguments) -> Dict[str, Any]:
        """
        执行 ATK 工具

        参数:
            tool_name: 工具名称
            arguments: 工具参数（dict 或 JSON 字符串）

        Returns:
            dict: 执行结果
        """
        if not self.tools:
            return {"error": "ATK 工具未初始化"}

        # 兼容 LLM 返回 JSON 字符串而非 dict 的情况
        print(f"  [Debug] execute_tool 收到 arguments 类型: {type(arguments).__name__}, 值: {repr(arguments)[:200]}")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
                print(f"  [Debug] JSON 解析后: {arguments}")
            except json.JSONDecodeError as e:
                return {"error": f"工具参数格式错误，无法解析 JSON: {arguments}\n解析错误: {e}"}

        # 确保 arguments 是字典类型
        if not isinstance(arguments, dict):
            return {"error": f"工具参数必须是字典类型，当前类型: {type(arguments).__name__}"}

        try:
            print(f"    [Debug] 准备调用工具: {tool_name}")
            print(f"    [Debug] 参数类型: {type(arguments).__name__}")
            print(f"    [Debug] 参数内容: {arguments}")
            
            if tool_name == "create_scenario":
                return self.tools.create_scenario(**arguments)
            elif tool_name == "set_scenario_time":
                return self.tools.set_scenario_time(**arguments)
            elif tool_name == "create_satellite":
                return self.tools.create_satellite(**arguments)
            elif tool_name == "set_satellite_classical":
                return self.tools.set_satellite_classical(**arguments)
            elif tool_name == "set_satellite_cartesian":
                return self.tools.set_satellite_cartesian(**arguments)
            elif tool_name == "create_facility":
                return self.tools.create_facility(**arguments)
            elif tool_name == "set_central_body":
                print(f"    [Debug] 调用 set_central_body, 参数: {arguments}")
                return self.tools.set_central_body(**arguments)
            elif tool_name == "run_simulation":
                return self.tools.run_simulation()
            elif tool_name == "save_scenario":
                return self.tools.save_scenario(**arguments)
            elif tool_name == "get_satellite_position":
                return self.tools.get_satellite_position(**arguments)
            else:
                return {"error": f"未知工具: {tool_name}"}
        except TypeError as te:
            error_msg = f"工具参数类型错误: {te}\n参数: {arguments}"
            print(f"    [Error] {error_msg}")
            return {"error": error_msg}
        except Exception as e:
            error_msg = f"工具执行失败: {type(e).__name__}: {e}\n参数: {arguments}"
            print(f"    [Error] {error_msg}")
            return {"error": error_msg}
    
    def chat(self, user_message: str) -> str:
        """
        与 ATK Agent 对话（ReAct 循环）
        
        ReAct 循环：
        1. 思考(Think): LLM 分析用户需求，决定下一步行动
        2. 行动(Act): 调用 ATK 工具
        3. 观察(Observed): 获取工具执行结果
        4. 验证(Verify): LLM 判断任务是否完成
        5. 继续/完成: 如果未完成，回到步骤1；如果完成，返回最终回复
        
        参数:
            user_message: 用户消息
        
        Returns:
            str: Agent 回复
        """
        # 添加用户消息到对话历史
        self.conversation_history.append({
            "role": "user",
            "content": user_message
        })
        
        # 加载 ATK CONNECT 命令库
        command_ref_path = os.path.join(os.path.dirname(__file__), "ATK_CONNECT_COMMANDS.md")
        command_reference = ""
        try:
            with open(command_ref_path, 'r', encoding='utf-8') as f:
                command_reference = f.read()
        except Exception as e:
            command_reference = f"命令库文件加载失败: {e}"
        
        # 系统提示 - 包含完整工具箱和使用指南
        system_prompt = f"""你是 ATK Agent，一个能够直接控制 ATK（Aerospace Tool Kit）航天任务设计工具箱的 AI 助手。

你的能力：
1. 理解用户的自然语言需求
2. 调用 ATK 工具完成操作
3. 返回操作结果

## ATK CONNECT 命令库参考

以下是完整的 ATK CONNECT 命令库，你必须严格遵守这些命令格式：

```
{command_reference}
```

## 可用工具

### 场景操作
- **create_scenario(name, start_time, end_time, step_seconds=60, central_body="Earth")**: 创建仿真场景
  - name: 场景名称（必须英文，如 'MyScenario'）
  - start_time/end_time: 时间格式 '5 Nov 2022 00:00:00.000'
  - **⚠️ 中心天体必须在此步骤指定！**
    - 地球场景：central_body="Earth"（默认，可不传）
    - 月球场景：central_body="Moon"（**必须显式指定！**）
    - 火星场景：central_body="Mars"（**必须显式指定！**）

- **save_scenario(filepath)**: 保存场景到文件

### 卫星操作
- **create_satellite(name)**: 创建卫星对象
  - name: 卫星名称（必须英文，如 'LEOSat'）

- **set_satellite_classical(name, propagator, start_time, end_time, step_seconds, coord_system, orbit_epoch, sma, ecc, inc, argp, raan, ma)**: 设置卫星轨道（轨道根数）
  - propagator: TwoBody/J2Perturbation/J4Perturbation/HPOP/LOP
  - coord_system: J2000 或 Fixed
  - sma: 半长轴（米）
  - ecc: 偏心率（0~1）
  - inc: 轨道倾角（度）
  - argp: 近地点角（度）
  - raan: 升交点赤经（度）
  - ma: 平近点角（度）

- **set_satellite_cartesian(name, propagator, start_time, end_time, step_seconds, coord_system, orbit_epoch, x, y, z, vx, vy, vz)**: 设置卫星轨道（位置速度）

- **get_satellite_position(name, time)**: 获取卫星当前位置

### 地面站操作
- **create_facility(name, lat, lon, alt_km=0)**: 创建地面站
  - name: 地面站名称（必须英文，如 'BeijingGS'）
  - lat/lon: 纬度/经度（度）
  - alt_km: 海拔（km）

### 天体配置
- **set_central_body(name, body_type)**: 设置场景的中心天体（地球、月球、火星等）
  - name: 天体名称（Earth, Moon, Mars, Sun 等）
  - body_type: 天体类型（CentralBody）
  - **重要**：如果要创建月球/火星为中心的场景，必须先调用此工具！
  - 示例：`{{"name": "Moon", "body_type": "CentralBody"}}`

### 仿真控制
- **run_simulation()**: 运行仿真（播放动画）

## 常见卫星轨道参数

### 地球轨道

#### 近地轨道 (LEO) - 高度 200-2000km
- 半长轴: 6578100 ~ 8378100 米（地球半径 6378km + 高度）
- 偏心率: 0（圆轨道）
- 倾角: 28°（航天飞机）、51.6°（ISS）、98.4°（太阳同步）
- 预报器: HPOP（高精度）
- 示例: ISS → sma=6778100, ecc=0, inc=51.6

### 中地球轨道 (MEO) - 高度 2000-35786km
- GPS: sma=26560000, ecc=0.01, inc=55
- GLONASS: sma=25510000, ecc=0.001, inc=64.8

### 地球同步轨道 (GEO) - 高度 35786km
- sma=42164197, ecc=0, inc=0

### 地球转移轨道 (GTO)
- sma≈24400000, ecc=0.73, inc=28.5

### 月球轨道

#### 月球半径：1737.4 km
#### 月球质量：7.342×10²² kg

#### 近月轨道 (LLO) - 高度 100km
- 半长轴: 1837400 米（1737.4 + 100 = 1837.4 km）
- 偏心率: 0
- 倾角: 0°（赤道轨道）或 90°（极轨道）
- 预报器: TwoBody（简化）或 HPOP
- 示例: `sma=1837400, ecc=0, inc=90`

#### 月球极地轨道
- 半长轴: 1837400 米
- 倾角: 90°
- 用途: 月球全球观测

### 火星轨道

#### 火星半径：3389.5 km
#### 火星质量：6.39×10²³ kg

#### 近火轨道 (LMO) - 高度 400km
- 半长轴: 3789500 米
- 偏心率: 0
- 倾角: 93°（太阳同步）

## 工作流程

### 地球场景
1. **创建场景**（create_scenario，central_body="Earth" 或不传）
2. **创建对象**（卫星、地面站等）
3. **设置对象属性**（轨道参数等）
4. **运行仿真**（run_simulation）
5. **保存场景**（save_scenario）

### 月球场景（月球为中心）⚠️ 关键！
1. **创建场景**（create_scenario，**必须**指定 central_body="Moon"）
2. **创建卫星**（create_satellite）
3. **设置卫星轨道**（set_satellite_classical）
   - 月球轨道参数示例：sma=1837400, ecc=0, inc=90
4. **运行仿真**（run_simulation）
5. **保存场景**（save_scenario）

### 火星场景（火星为中心）⚠️ 关键！
1. **创建场景**（create_scenario，**必须**指定 central_body="Mars"）
2. **创建卫星**（create_satellite）
3. **设置卫星轨道**（set_satellite_classical）
4. **运行仿真**（run_simulation）
5. **保存场景**（save_scenario）

## 重要规则

1. **所有 ATK 对象名称必须使用英文**（如 'LEOSat', 'BeijingGS', 'MyScenario'），禁止使用中文、拼音或特殊字符
2. 时间格式必须使用 ATK 格式，如 "5 Nov 2022 00:00:00.000"
3. 轨道参数单位：半长轴(米)、偏心率(无量纲)、倾角(度)
4. 坐标系使用 J2000
5. 轨道预报器常用 HPOP（高精度）
6. **月球/火星场景必须先调用 set_central_body 设置中心天体！**

## ReAct 执行规则

1. **每次只调用一个工具**，等待结果后再决定下一步
2. **每步都要报告进度**：工具调用成功/失败都要明确告知用户
3. **任务完成后给出完整总结**
4. **工具调用失败时**：分析原因，最多重试 3 次，无法修复则告知用户

请根据用户需求，按顺序调用工具。"""
        
        messages = [
            {"role": "system", "content": system_prompt}
        ] + self.conversation_history
        
        tools_def = self.get_tools_definition()
        
        # ReAct 循环：最多 15 步
        max_steps = 15
        step_history = []  # 记录所有步骤
        
        for step in range(max_steps):
            print(f"\n[ReAct Step {step + 1}/{max_steps}]")
            
            # 1. 调用 LLM
            response = self.call_llm(messages, tools=tools_def)
            
            if "error" in response:
                return f"LLM 调用失败: {response['error']}"
            
            # 2. 解析 LLM 响应
            try:
                assistant_message = response["choices"][0]["message"]
                
                # 检查是否有工具调用
                if "tool_calls" in assistant_message and assistant_message["tool_calls"]:
                    # 只执行第一个工具调用（ReAct 模式：一步一步来）
                    tool_call = assistant_message["tool_calls"][0]
                    function_name = tool_call["function"]["name"]
                    raw_args = tool_call["function"]["arguments"]
                    
                    # LLM 可能返回 dict 或 JSON 字符串
                    if isinstance(raw_args, str):
                        try:
                            function_args = json.loads(raw_args)
                        except json.JSONDecodeError as json_err:
                            error_msg = f"工具参数 JSON 解析失败: {raw_args}\n错误详情: {json_err}"
                            print(f"  [Error] {error_msg}")
                            # 添加错误信息到对话历史，让 LLM 知道解析失败
                            messages.append({
                                "role": "assistant",
                                "content": None,
                                "tool_calls": [tool_call]
                            })
                            messages.append({
                                "role": "tool",
                                "content": json.dumps({"error": error_msg}, ensure_ascii=False),
                                "tool_call_id": tool_call["id"]
                            })
                            continue  # 跳过本次循环，让 LLM 重新生成
                    else:
                        function_args = raw_args
                    
                    print(f"  [Act] 调用工具: {function_name}")
                    print(f"  [Act] 参数: {function_args}")
                    
                    # 执行工具
                    result = self.execute_tool(function_name, function_args)
                    
                    print(f"  [Observe] 结果: {result}")
                    
                    # 记录步骤
                    step_history.append({
                        "step": step + 1,
                        "tool": function_name,
                        "args": function_args,
                        "result": result
                    })
                    
                    # 添加工具调用到对话历史
                    messages.append({
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [tool_call]
                    })
                    messages.append({
                        "role": "tool",
                        "content": json.dumps(result, ensure_ascii=False),
                        "tool_call_id": tool_call["id"]
                    })
                    
                else:
                    # 没有工具调用，说明任务完成
                    reply = assistant_message.get("content", "")
                    
                    # 如果有步骤历史，追加总结
                    if step_history:
                        summary = f"\n\n--- 执行摘要 ---\n共执行 {len(step_history)} 步操作：\n"
                        for s in step_history:
                            summary += f"  步骤 {s['step']}: {s['tool']} → {s['result'].get('status', 'unknown')}\n"
                        reply += summary
                    
                    self.conversation_history.append({
                        "role": "assistant",
                        "content": reply
                    })
                    return reply
                    
            except Exception as e:
                return f"解析 LLM 响应失败: {e}"
        
        # 超过最大步骤数 - 返回完整摘要
        summary = f"任务执行超过最大步骤数({max_steps}步)，可能未完成。\n\n执行摘要：\n"
        for s in step_history:
            summary += f"  步骤 {s['step']}: {s['tool']}({s['args']}) → {s['result'].get('status', 'unknown')}\n"
        
        return summary
    
    def __del__(self):
        self.stop_atk()


def main():
    """主函数 - 命令行交互"""
    print("=" * 60)
    print("ATK Agent - AI Agent for ATK Control")
    print("=" * 60)
    print()
    
    # 检查 API Key
    if not LLM_API_KEY:
        print("⚠️  警告：未配置 DeepSeek API Key")
        print("   请编辑 config.py，填入你的 API Key")
        print()
        print("   或者使用 --no-llm 参数跳过 LLM 模式")
        print()
    
    # 创建 Agent
    agent = ATKAgent()
    
    # 启动 ATK
    if not agent.start_atk():
        print("ATK 启动失败，请检查 ATK 路径和配置")
        return
    
    # 连接 ATK
    if not agent.connect_atk():
        print("ATK 连接失败，请检查 ATK 是否正常运行")
        return
    
    print()
    print("ATK Agent 已就绪！")
    print("输入 'quit' 或 'exit' 退出")
    print()
    
    print("可用命令:")
    print("  /scenario <name> <start> <end>  - 创建场景")
    print("  /satellite <name>               - 创建卫星")
    print("  /facility <name> <lat> <lon>    - 创建地面站")
    print("  /run                            - 运行仿真")
    print("  /save [filepath]                - 保存场景")
    print("  /quit                           - 退出")
    print()
    
    while True:
        try:
            user_input = input("你: ").strip()
            if not user_input:
                continue
            if user_input.lower() in ['quit', 'exit', 'q', '/quit']:
                break
            
            # 直接命令模式（不需要 LLM）
            if user_input.startswith('/'):
                parts = user_input[1:].split()
                cmd = parts[0].lower()
                
                if cmd == 'scenario' and len(parts) >= 4:
                    result = agent.tools.create_scenario(
                        name=parts[1],
                        start_time=' '.join(parts[2:-1]),
                        end_time=parts[-1]
                    )
                    print(f"  结果: {result}")
                elif cmd == 'satellite' and len(parts) >= 2:
                    result = agent.tools.create_satellite(name=parts[1])
                    print(f"  结果: {result}")
                elif cmd == 'facility' and len(parts) >= 4:
                    result = agent.tools.create_facility(
                        name=parts[1],
                        lat=float(parts[2]),
                        lon=float(parts[3])
                    )
                    print(f"  结果: {result}")
                elif cmd == 'run':
                    result = agent.tools.run_simulation()
                    print(f"  结果: {result}")
                elif cmd == 'save':
                    filepath = parts[1] if len(parts) > 1 else None
                    result = agent.tools.save_scenario(filepath=filepath)
                    print(f"  结果: {result}")
                else:
                    print(f"  未知命令: {user_input}")
            else:
                # LLM 模式（ReAct 循环）
                if not LLM_API_KEY:
                    print("\n⚠️  未配置 API Key，请使用 / 命令模式")
                    print("   或者编辑 config.py 填入 DeepSeek API Key")
                    continue
                
                reply = agent.chat(user_input)
                print(f"\nATK Agent: {reply}\n")
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"\n错误: {e}\n")
    
    # 清理
    agent.stop_atk()
    print("ATK Agent 已关闭")


if __name__ == "__main__":
    main()
