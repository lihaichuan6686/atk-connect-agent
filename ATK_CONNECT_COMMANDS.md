# ATK CONNECT 命令库完整参考

## 1. 命令格式

```python
atkConnect(conID, command, param)
```

- `conID`: 连接 ID（atkOpen 返回）
- `command`: 命令名称（如 New, SetState, Animate 等）
- `param`: 参数字符串（包含对象路径和参数）
- 返回值：空字符串表示成功，NACK 表示命令已接收但有警告

## 2. 场景命令

### 2.1 新建场景
```
atkConnect(conID, "New", "/ Scenario <name>")
```
- 创建新场景
- 示例：`atkConnect(conID, "New", "/ Scenario MyScenario")`

### 2.2 设置分析时间段
```
atkConnect(conID, "SetAnalysisTimePeriod", '* "<start_time>" "<end_time>"')
```
- 设置仿真开始和结束时间
- 时间格式：`5 Nov 2022 00:00:00.000`
- 示例：`atkConnect(conID, "SetAnalysisTimePeriod", '* "5 Nov 2022 00:00:00.000" "8 Nov 2022 00:00:00.000"')`

### 2.3 设置仿真步长
```
atkConnect(conID, "Animate", "* Step <seconds>")
```
- 设置仿真步长（秒）
- 示例：`atkConnect(conID, "Animate", "* Step 60")`

### 2.4 运行仿真
```
atkConnect(conID, "Animate", "* Start")
```
- 开始仿真
- 示例：`atkConnect(conID, "Animate", "* Start")`

### 2.5 重置仿真
```
atkConnect(conID, "Animate", "* Reset")
```
- 重置仿真到开始时间
- 示例：`atkConnect(conID, "Animate", "* Reset")`

### 2.6 保存场景
```
atkConnect(conID, "Save", "*/ <filepath>")
```
- 保存场景到文件
- 示例：`atkConnect(conID, "Save", "*/ C:/atk/scenarios/MyScenario.xml")`

## 3. 卫星命令

### 3.1 新建卫星
```
atkConnect(conID, "New", "/ Satellite <name>")
```
- 创建新卫星
- 示例：`atkConnect(conID, "New", "/ Satellite LEOSat")`

### 3.2 设置卫星轨道（Classical - 轨道根数模式）
```
atkConnect(conID, "SetState", '*/Satellite/<name> Classical <propagator> "<start>" "<end>" <step> <coord_system> "<epoch>" <sma> <ecc> <inc> <argp> <raan> <ma>')
```
- 使用轨道根数设置卫星状态
- 参数：
  - propagator: TwoBody, J2Perturbation, J4Perturbation, HPOP, LOP
  - coord_system: J2000, Fixed
  - sma: 半长轴（米）
  - ecc: 偏心率（0~1）
  - inc: 轨道倾角（度）
  - argp: 近地点角（度）
  - raan: 升交点赤经（度）
  - ma: 平近点角（度）
- 示例：
```python
atkConnect(conID, "SetState", '*/Satellite/LEOSat Classical HPOP "5 Nov 2022 00:00:00.000" "8 Nov 2022 00:00:00.000" 60 J2000 "5 Nov 2022 00:00:00.000" 6778100 0 51.6 0 0 0')
```

### 3.3 设置卫星轨道（Cartesian - 位置速度模式）
```
atkConnect(conID, "SetState", '*/Satellite/<name> Cartesian <propagator> "<start>" "<end>" <step> <coord_system> "<epoch>" <x> <y> <z> <vx> <vy> <vz>')
```
- 使用位置速度设置卫星状态
- 参数：
  - x, y, z: 位置（米）
  - vx, vy, vz: 速度（m/sec）
- 示例：
```python
atkConnect(conID, "SetState", '*/Satellite/LEOSat Cartesian HPOP "5 Nov 2022 00:00:00.000" "8 Nov 2022 00:00:00.000" 60 J2000 "5 Nov 2022 00:00:00.000" -1000000 5000000 4000000 5000 -3000 2000')
```

### 3.4 设置卫星 TLE
```
atkConnect(conID, "SetState", '*/Satellite/<name> TLE "<tle_card1>" "<tle_card2>"')
```
- 使用 TLE 数据设置卫星轨道
- 示例：
```python
atkConnect(conID, "SetState", '*/Satellite/LEOSat TLE "1 25544U 98067A   22308.50000000  .00000000  00000-0  00000-0 0  9001" "2 25544  51.6400 200.0000 0001000  50.0000 310.0000 15.50000000000000"')
```

### 3.5 获取卫星位置
```
atkConnect(conID, "Position", '*/Satellite/<name> "<time>"')
```
- 获取卫星在指定时间的位置
- 示例：`atkConnect(conID, "Position", '*/Satellite/LEOSat "5 Nov 2022 00:00:00.000"')`

### 3.6 设置卫星可视化
```
atkConnect(conID, "Graphics", '*/Satellite/<name> Basic Show <on/off> Label <on/off> Orbit <on/off> LineWidth <width> color <color>')
```
- 设置卫星可视化属性
- 示例：
```python
atkConnect(conID, "Graphics", '*/Satellite/LEOSat Basic Show on Label on Orbit on LineWidth 2.0 color 15')
```

## 4. 地面站命令

### 4.1 新建地面站
```
atkConnect(conID, "New", "/ Facility <name>")
```
- 创建新地面站
- 示例：`atkConnect(conID, "New", "/ Facility BeijingGS")`

### 4.2 设置地面站位置
```
atkConnect(conID, "SetPosition", '*/Facility/<name> Geoditic <lat> <lon> <alt>')
```
- 设置地面站位置（大地坐标系）
- 参数：
  - lat: 纬度（度）
  - lon: 经度（度）
  - alt: 海拔（米）
- 示例：
```python
atkConnect(conID, "SetPosition", '*/Facility/BeijingGS Geoditic 39.9 116.4 50')
```

## 5. 天体命令

### 5.1 设置中心天体
```
atkConnect(conID, "SetCentralBody", '*/ <body_type> <name>')
```
- 设置场景的中心天体
- 参数：
  - body_type: CentralBody
  - name: Earth, Moon, Mars, Sun 等
- 示例：
```python
atkConnect(conID, "SetCentralBody", '*/ CentralBody Moon')
```

## 6. 传感器命令

### 6.1 新建传感器
```
atkConnect(conID, "New", "/ Satellite/<sat_name>/ Sensor <name>")
```
- 在卫星上创建传感器
- 示例：`atkConnect(conID, "New", "/ Satellite/LEOSat/ Sensor Camera")`

## 7. 链路命令

### 7.1 新建链路
```
atkConnect(conID, "New", "/ Link <name>")
```
- 创建新链路
- 示例：`atkConnect(conID, "New", "/ Link CommLink")`

## 8. 批量操作

### 8.1 批量创建卫星
```
atkConnect(conID, "NewMulti", "/ Satellite <name1> <name2> ...")
```
- 批量创建多个卫星
- 示例：`atkConnect(conID, "NewMulti", "/ Satellite Sat1 Sat2 Sat3")`

## 9. 常见轨道参数

### 9.1 地球轨道

#### 近地轨道 (LEO) - 高度 200-2000km
- 半长轴: 6578100 ~ 8378100 米（地球半径 6378km + 高度）
- 偏心率: 0（圆轨道）
- 倾角: 28°（航天飞机）、51.6°（ISS）、98.4°（太阳同步）
- 预报器: HPOP（高精度）

#### 中地球轨道 (MEO) - 高度 2000-35786km
- GPS: sma=26560000, ecc=0.01, inc=55
- GLONASS: sma=25510000, ecc=0.001, inc=64.8

#### 地球同步轨道 (GEO) - 高度 35786km
- sma=42164197, ecc=0, inc=0

#### 地球转移轨道 (GTO)
- sma≈24400000, ecc=0.73, inc=28.5

### 9.2 月球轨道

#### 月球半径：1737.4 km
#### 月球质量：7.342×10²² kg

#### 近月轨道 (LLO) - 高度 100km
- 半长轴: 1837400 米（1737.4 + 100 = 1837.4 km）
- 偏心率: 0
- 倾角: 0°（赤道轨道）或 90°（极轨道）
- 预报器: TwoBody（简化）或 HPOP

#### 月球极地轨道
- 半长轴: 1837400 米
- 倾角: 90°
- 用途: 月球全球观测

### 9.3 火星轨道

#### 火星半径：3389.5 km
#### 火星质量：6.39×10²³ kg

#### 近火轨道 (LMO) - 高度 400km
- 半长轴: 3789500 米
- 偏心率: 0
- 倾角: 93°（太阳同步）

## 10. 完整工作流程示例

### 10.1 创建地球 LEO 卫星场景
```python
# 1. 新建场景
atkConnect(conID, "New", "/ Scenario LEOScenario")

# 2. 设置分析时间段
atkConnect(conID, "SetAnalysisTimePeriod", '* "5 Nov 2022 00:00:00.000" "8 Nov 2022 00:00:00.000"')

# 3. 设置仿真步长
atkConnect(conID, "Animate", "* Step 60")

# 4. 新建卫星
atkConnect(conID, "New", "/ Satellite LEOSat")

# 5. 设置卫星轨道
atkConnect(conID, "SetState", '*/Satellite/LEOSat Classical HPOP "5 Nov 2022 00:00:00.000" "8 Nov 2022 00:00:00.000" 60 J2000 "5 Nov 2022 00:00:00.000" 6778100 0 51.6 0 0 0')

# 6. 设置卫星可视化
atkConnect(conID, "Graphics", '*/Satellite/LEOSat Basic Show on Label on Orbit on LineWidth 2.0 color 15')

# 7. 运行仿真
atkConnect(conID, "Animate", "* Start")
```

### 10.2 创建月球轨道场景（月球为中心）
```python
# 1. 新建场景
atkConnect(conID, "New", "/ Scenario LunarScenario")

# 2. 设置中心天体为月球（关键步骤！）
atkConnect(conID, "SetCentralBody", '*/ CentralBody Moon')

# 3. 设置分析时间段
atkConnect(conID, "SetAnalysisTimePeriod", '* "5 Nov 2022 00:00:00.000" "10 Nov 2022 00:00:00.000"')

# 4. 设置仿真步长
atkConnect(conID, "Animate", "* Step 60")

# 5. 新建卫星
atkConnect(conID, "New", "/ Satellite LunarOrbiter")

# 6. 设置卫星轨道（月球轨道）
atkConnect(conID, "SetState", '*/Satellite/LunarOrbiter Classical TwoBody "5 Nov 2022 00:00:00.000" "10 Nov 2022 00:00:00.000" 60 J2000 "5 Nov 2022 00:00:00.000" 1837400 0 90 0 0 0')

# 7. 设置卫星可视化
atkConnect(conID, "Graphics", '*/Satellite/LunarOrbiter Basic Show on Label on Orbit on LineWidth 2.0 color 15')

# 8. 运行仿真
atkConnect(conID, "Animate", "* Start")
```

## 11. 重要规则

### 11.1 命名规则
- **必须使用英文**：'LEOSat', 'MyScenario', 'BeijingGS'
- **禁止使用**：中文、拼音、特殊字符、空格
- **推荐格式**：驼峰命名法（CamelCase）

### 11.2 时间格式
- **ATK 格式**：'5 Nov 2022 00:00:00.000'
- **月份缩写**：Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec
- **示例**：'1 Jan 2023 12:00:00.000'

### 11.3 单位
- **长度**：米（m）
- **速度**：米/秒（m/sec）
- **角度**：度（deg）
- **时间**：秒（sec）

### 11.4 坐标系
- **J2000**：惯性坐标系（推荐）
- **Fixed**：地球固定坐标系

### 11.5 轨道预报器
- **HPOP**：高精度轨道预报器（地球轨道推荐）
- **J2Perturbation**：考虑 J2 摄动
- **TwoBody**：二体问题（月球/火星轨道常用）

### 11.6 天体配置
- **地球场景**：默认中心天体为 Earth，无需额外设置
- **月球场景**：必须调用 `SetCentralBody` 设置中心天体为 Moon
- **火星场景**：必须调用 `SetCentralBody` 设置中心天体为 Mars

## 12. 常见错误

### 12.1 忘记创建场景
- **错误**：直接创建卫星
- **正确**：先调用 `New / Scenario <name>`，再创建卫星

### 12.2 中文命名
- **错误**：`New / Satellite 我的卫星`
- **正确**：`New / Satellite LEOSat`

### 12.3 时间格式错误
- **错误**：`2022-11-05 00:00:00`
- **正确**：`5 Nov 2022 00:00:00.000`

### 12.4 半长轴单位错误
- **错误**：sma=6778（km）
- **正确**：sma=6778100（米）

### 12.5 月球场景忘记设置中心天体
- **错误**：直接创建卫星（默认地球为中心）
- **正确**：先调用 `SetCentralBody */ CentralBody Moon`，再创建卫星
