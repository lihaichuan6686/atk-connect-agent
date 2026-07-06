# ATK Agent 参考手册

## 1. 可用工具清单

### 1.1 场景操作

#### create_scenario(name, start_time, end_time, step_seconds=60)
- **用途**：创建 ATK 仿真场景（必须首先调用）
- **参数**：
  - `name`: 场景名称（英文，如 'MyScenario'）
  - `start_time`: 开始时间，格式 '5 Nov 2022 00:00:00.000'
  - `end_time`: 结束时间
  - `step_seconds`: 仿真步长（秒），默认 60
- **示例**：
  ```json
  {"name": "LEOScenario", "start_time": "5 Nov 2022 00:00:00.000", "end_time": "8 Nov 2022 00:00:00.000", "step_seconds": 60}
  ```

#### save_scenario(filepath)
- **用途**：保存场景到文件
- **参数**：
  - `filepath`: 保存路径（可选，如 'C:/atk/scenarios/MyScenario.xml'）

### 1.2 天体配置

#### set_central_body(name, body_type)
- **用途**：设置场景的中心天体（地球、月球等）
- **参数**：
  - `name`: 天体名称（Earth, Moon, Mars, Sun 等）
  - `body_type`: 天体类型（CentralBody）
- **示例**：
  ```json
  {"name": "Moon", "body_type": "CentralBody"}
  ```
- **重要**：如果要创建月球为中心的场景，必须先调用此工具设置中心天体为 Moon

### 1.3 卫星操作

#### create_satellite(name)
- **用途**：创建卫星对象
- **参数**：
  - `name`: 卫星名称（英文，如 'LEOSat'）
- **示例**：
  ```json
  {"name": "LEOSat"}
  ```

#### set_satellite_classical(name, propagator, start_time, end_time, step_seconds, coord_system, orbit_epoch, sma, ecc, inc, argp, raan, ma)
- **用途**：设置卫星轨道（轨道根数模式）
- **参数**：
  - `name`: 卫星名称
  - `propagator`: 轨道预报器（TwoBody, J2Perturbation, J4Perturbation, HPOP, LOP）
  - `start_time`: 开始时间
  - `end_time`: 结束时间
  - `step_seconds`: 步长（秒）
  - `coord_system`: 坐标系（J2000 或 Fixed）
  - `orbit_epoch`: 轨道历元
  - `sma`: 半长轴（米）
  - `ecc`: 偏心率（0~1）
  - `inc`: 轨道倾角（度）
  - `argp`: 近地点角（度）
  - `raan`: 升交点赤经（度）
  - `ma`: 平近点角（度）

#### set_satellite_cartesian(name, propagator, start_time, end_time, step_seconds, coord_system, orbit_epoch, x, y, z, vx, vy, vz)
- **用途**：设置卫星轨道（位置速度模式）

#### get_satellite_position(name, time)
- **用途**：获取卫星当前位置

### 1.4 地面站操作

#### create_facility(name, lat, lon, alt_km=0)
- **用途**：创建地面站
- **参数**：
  - `name`: 地面站名称（英文，如 'BeijingGS'）
  - `lat`: 纬度（度）
  - `lon`: 经度（度）
  - `alt_km`: 海拔（km），默认 0

### 1.5 仿真控制

#### run_simulation()
- **用途**：运行仿真（播放动画）

## 2. 常见卫星轨道参数

### 2.1 地球轨道

#### 近地轨道 (LEO) - 高度 200-2000km
- **半长轴**：6578100 ~ 8378100 米（地球半径 6378km + 高度）
- **偏心率**：0（圆轨道）
- **倾角**：常用 28°（航天飞机）、51.6°（ISS）、98.4°（太阳同步）
- **预报器**：HPOP（高精度）或 J2Perturbation
- **示例**：
  - ISS：sma=6778100, ecc=0, inc=51.6
  - 太阳同步：sma=7128100, ecc=0.001, inc=98.4

#### 中地球轨道 (MEO) - 高度 2000-35786km
- **半长轴**：8378100 ~ 42164197 米
- **GPS 轨道**：sma=26560000, ecc=0.01, inc=55
- **GLONASS 轨道**：sma=25510000, ecc=0.001, inc=64.8

#### 地球同步轨道 (GEO) - 高度 35786km
- **半长轴**：42164197 米
- **偏心率**：0
- **倾角**：0（赤道轨道）

#### 地球转移轨道 (GTO)
- **半长轴**：约 24400000 米
- **偏心率**：0.73
- **倾角**：28.5（从 Cape Canaveral 发射）

### 2.2 月球轨道

#### 月球半径：1737.4 km
#### 月球质量：7.342×10²² kg
#### 月球引力常数 (GM)：4902.803 m³/s²

#### 近月轨道 (LLO) - 高度 100km
- **半长轴**：1837400 米（1737.4 + 100 = 1837.4 km）
- **偏心率**：0
- **倾角**：0°（赤道轨道）或 90°（极轨道）
- **预报器**：TwoBody（简化）或 HPOP
- **示例**：
  ```json
  {"name": "LunarSat", "propagator": "TwoBody", "sma": 1837400, "ecc": 0, "inc": 90}
  ```

#### 月球极地轨道
- **半长轴**：1837400 米
- **倾角**：90°
- **用途**：月球全球观测

#### 月球同步轨道
- **半长轴**：约 58200000 米（与月球公转周期同步）
- **用途**：月球观测站

### 2.3 火星轨道

#### 火星半径：3389.5 km
#### 火星质量：6.39×10²³ kg

#### 近火轨道 (LMO) - 高度 400km
- **半长轴**：3789500 米
- **偏心率**：0
- **倾角**：93°（太阳同步）

## 3. 常见工作流程

### 3.1 创建地球 LEO 卫星场景
1. `create_scenario("LEOScenario", "5 Nov 2022 00:00:00.000", "8 Nov 2022 00:00:00.000", 60)`
2. `create_satellite("LEOSat")`
3. `set_satellite_classical("LEOSat", "HPOP", "5 Nov 2022 00:00:00.000", "8 Nov 2022 00:00:00.000", 60, "J2000", "5 Nov 2022 00:00:00.000", 6778100, 0, 51.6, 0, 0, 0)`
4. `run_simulation()`
5. `save_scenario()`

### 3.2 创建月球轨道场景（月球为中心）
1. `create_scenario("LunarScenario", "5 Nov 2022 00:00:00.000", "10 Nov 2022 00:00:00.000", 60)`
2. `set_central_body("Moon", "CentralBody")` ← **关键步骤：设置中心天体为月球**
3. `create_satellite("LunarOrbiter")`
4. `set_satellite_classical("LunarOrbiter", "TwoBody", "5 Nov 2022 00:00:00.000", "10 Nov 2022 00:00:00.000", 60, "J2000", "5 Nov 2022 00:00:00.000", 1837400, 0, 90, 0, 0, 0)`
5. `run_simulation()`
6. `save_scenario()`

### 3.3 创建地月转移轨道
1. `create_scenario("TransLunar", "5 Nov 2022 00:00:00.000", "10 Nov 2022 00:00:00.000", 60)`
2. `create_satellite("TLISpacecraft")`
3. `set_satellite_classical("TLISpacecraft", "HPOP", "5 Nov 2022 00:00:00.000", "10 Nov 2022 00:00:00.000", 60, "J2000", "5 Nov 2022 00:00:00.000", 42164197, 0.73, 28.5, 0, 0, 0)`
4. `run_simulation()`

### 3.4 创建多个卫星星座
1. `create_scenario("Constellation", "5 Nov 2022 00:00:00.000", "8 Nov 2022 00:00:00.000", 60)`
2. `create_satellite("Sat1")`
3. `set_satellite_classical("Sat1", ...)`
4. `create_satellite("Sat2")`
5. `set_satellite_classical("Sat2", ...)`
6. `run_simulation()`

## 4. 重要规则

### 4.1 命名规则
- **必须使用英文**：'LEOSat', 'MyScenario', 'BeijingGS'
- **禁止使用**：中文、拼音、特殊字符、空格
- **推荐格式**：驼峰命名法（CamelCase）

### 4.2 时间格式
- **ATK 格式**：'5 Nov 2022 00:00:00.000'
- **月份缩写**：Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec
- **示例**：'1 Jan 2023 12:00:00.000'

### 4.3 单位
- **长度**：米（m）
- **速度**：米/秒（m/sec）
- **角度**：度（deg）
- **时间**：秒（sec）

### 4.4 坐标系
- **J2000**：惯性坐标系（推荐）
- **Fixed**：地球固定坐标系

### 4.5 轨道预报器
- **HPOP**：高精度轨道预报器（地球轨道推荐）
- **J2Perturbation**：考虑 J2 摄动
- **TwoBody**：二体问题（月球/火星轨道常用）

### 4.6 天体配置
- **地球场景**：默认中心天体为 Earth，无需额外设置
- **月球场景**：必须调用 `set_central_body("Moon", "CentralBody")` 设置中心天体
- **火星场景**：必须调用 `set_central_body("Mars", "CentralBody")` 设置中心天体

## 5. 常见错误

### 5.1 忘记创建场景
- **错误**：直接创建卫星
- **正确**：先调用 create_scenario，再创建卫星

### 5.2 中文命名
- **错误**：create_satellite("我的卫星")
- **正确**：create_satellite("LEOSat")

### 5.3 时间格式错误
- **错误**：'2022-11-05 00:00:00'
- **正确**：'5 Nov 2022 00:00:00.000'

### 5.4 半长轴单位错误
- **错误**：sma=6778（km）
- **正确**：sma=6778100（米）

### 5.5 月球场景忘记设置中心天体
- **错误**：直接创建卫星（默认地球为中心）
- **正确**：先调用 `set_central_body("Moon", "CentralBody")`，再创建卫星

## 6. 执行流程

### 6.1 ReAct 循环
1. **思考**：分析用户需求，决定下一步
2. **行动**：调用一个工具
3. **观察**：查看工具执行结果
4. **验证**：判断任务是否完成
5. **继续/完成**：未完成回到步骤 1，完成返回回复

### 6.2 进度反馈
- 每步都要向用户报告进度
- 工具调用成功/失败都要明确告知
- 任务完成后给出完整总结

### 6.3 错误处理
- 工具调用失败时，分析原因并尝试修复
- 无法修复时，告知用户具体错误信息
- 不要无限重试，最多 3 次
