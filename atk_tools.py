"""
ATK Tools - ATK 操作工具集
基于 ATK 官方 CONNECT模式文档实现

参考文档：
- 二次开发教程/2-二次开发CONNECT模式/2-Connect命令库/
- 二次开发教程/2-二次开发CONNECT模式/6-Python客户端/2-举例.html

命令格式：atkConnect(conID, command, param)
例如：atkConnect(conID, 'New', '/ Scenario Test')
      atkConnect(conID, 'SetAnalysisTimePeriod', '* "5 Nov 2022 00:00:00.000" "8 Nov 2022 00:00:00.000"')
"""
import time
from typing import Optional, Dict, Any
from atk_connector import ATKConnector


class ATKTools:
    """
    ATK 操作工具集
    
    所有方法都基于 ATK 官方文档中的命令实现。
    """
    
    def __init__(self, connector: ATKConnector):
        self.conn = connector
        self.current_scenario: Optional[str] = None
    
    # ===== 场景操作 =====

    def create_scenario(self, name: str, start_time: str = "", end_time: str = "", step_seconds: float = 60, central_body: str = "Earth") -> Dict[str, Any]:
        """
        创建 ATK 仿真场景

        注意：ATK 的中心天体必须在创建场景时指定，不能之后修改。
        - 地球场景：central_body="Earth"（默认）
        - 月球场景：central_body="Moon"
        - 火星场景：central_body="Mars"

        参考文档：场景命令 - New
        """
        # 构建 New 命令参数
        if central_body and central_body.lower() != 'earth':
            # 非地球场景，需要指定中心天体
            param = f"/ Scenario {name} CentralBody {central_body}"
        else:
            # 地球场景（默认）
            param = f"/ Scenario {name}"
        
        result = self.conn.send_command("New", param)
        self.current_scenario = name

        # 如果提供了开始/结束时间，则自动设置
        if start_time and end_time:
            result += self.conn.send_command(
                "SetAnalysisTimePeriod",
                f'* "{start_time}" "{end_time}"'
            )
            result += self.conn.send_command(
                "Animate",
                f"* Step {step_seconds}"
            )
            auto_set = True
        else:
            auto_set = False

        return {
            "status": "success",
            "scenario": name,
            "central_body": central_body,
            "auto_set_time": auto_set,
            "response": result
        }

    def set_scenario_time(self, start_time: str, end_time: str, step_seconds: float = 60) -> Dict[str, Any]:
        """
        设置场景的分析时间段和仿真步长

        必须在 create_scenario 之后调用，对于月球/火星场景，必须在 set_central_body 之后调用。

        参考文档：场景命令 - SetAnalysisTimePeriod, Animate
        """
        if not self.current_scenario:
            return {"error": "未找到当前场景，请先调用 create_scenario"}

        result = self.conn.send_command(
            "SetAnalysisTimePeriod",
            f'* "{start_time}" "{end_time}"'
        )
        result += self.conn.send_command(
            "Animate",
            f"* Step {step_seconds}"
        )

        return {
            "status": "success",
            "scenario": self.current_scenario,
            "start_time": start_time,
            "end_time": end_time,
            "step_seconds": step_seconds,
            "response": result
        }

    def save_scenario(self, filepath: Optional[str] = None) -> Dict[str, Any]:
        """
        保存场景
        
        参考文档：场景命令 - Save
        """
        if filepath:
            result = self.conn.send_command("Save", f"*/ {filepath}")
        else:
            result = self.conn.send_command("Save", "*/ *")
        
        return {
            "status": "success",
            "response": result
        }
    
    # ===== 卫星操作 =====
    
    def create_satellite(self, name: str) -> Dict[str, Any]:
        """
        创建卫星对象
        
        参考文档：卫星命令 - New
        用法：atkConnect(conID, 'New', '/ Satellite <name>')
        """
        result = self.conn.send_command("New", f"/ Satellite {name}")
        
        return {
            "status": "success",
            "satellite": name,
            "response": result
        }
    
    def set_satellite_cartesian(self, name: str, 
                                 propagator: str,
                                 start_time: str,
                                 end_time: str,
                                 step_seconds: float,
                                 coord_system: str,
                                 orbit_epoch: str,
                                 x: float, y: float, z: float,
                                 vx: float, vy: float, vz: float) -> Dict[str, Any]:
        """
        设置卫星 Cartesian 状态
        
        参考文档：卫星命令 - SetState Cartesian
        用法：atkConnect(conID, 'SetState', '*/Satellite/<name> Cartesian ...')
        """
        param = (
            f"*/Satellite/{name} Cartesian {propagator} "
            f'"{start_time}" "{end_time}" {step_seconds} '
            f"{coord_system} "
            f'"{orbit_epoch}" '
            f"{x} {y} {z} {vx} {vy} {vz}"
        )
        result = self.conn.send_command("SetState", param)
        
        return {
            "status": "success",
            "satellite": name,
            "response": result
        }
    
    def set_satellite_classical(self, name: str,
                                 propagator: str,
                                 start_time: str,
                                 end_time: str,
                                 step_seconds: float,
                                 coord_system: str,
                                 orbit_epoch: str,
                                 sma: float,  # 半长轴 (m)
                                 ecc: float,  # 偏心率
                                 inc: float,  # 轨道倾角 (deg)
                                 argp: float,  # 近地点角 (deg)
                                 raan: float,  # 升交点赤经 (deg)
                                 ma: float) -> Dict[str, Any]:  # 平近点角 (deg)
        """
        设置卫星 Classical 状态（轨道根数）
        
        参考文档：卫星命令 - SetState Classical
        用法：atkConnect(conID, 'SetState', '*/Satellite/<name> Classical ...')
        """
        param = (
            f"*/Satellite/{name} Classical {propagator} "
            f'"{start_time}" "{end_time}" {step_seconds} '
            f"{coord_system} "
            f'"{orbit_epoch}" '
            f"{sma} {ecc} {inc} {argp} {raan} {ma}"
        )
        result = self.conn.send_command("SetState", param)
         # === 添加以下两行 ===
        self.conn.send_command("Animate", "* Reset")   # 重置仿真，刷新视图
        self.conn.send_command("Start3DUi", "/")       # 确保 3D 窗口已打开
        return {
            "status": "success",
            "satellite": name,
            "response": result
        }
    
    def set_satellite_sgp4(self, name: str,
                            step_seconds: float,
                            ssc_number: int,
                            tle_source: str = "DefineElements",
                            mean_motion: float = 0,
                            ecc: float = 0,
                            inc: float = 0,
                            argp: float = 0,
                            raan: float = 0,
                            ma: float = 0,
                            bstar: float = 0,
                            orbit_epoch_yyddd: str = "",
                            rev_number: int = 0) -> Dict[str, Any]:
        """
        设置卫星 SGP4 状态
        
        参考文档：卫星命令 - SetState SGP4
        """
        param = f"*/Satellite/{name} NoProp {step_seconds} {ssc_number} TLESource {tle_source}"
        
        if tle_source == "DefineElements" and mean_motion > 0:
            param += f" Source Elements OrbitEpochYYDDD {orbit_epoch_yyddd} "
            param += f"ElementSet {mean_motion} {ecc} {inc} {argp} {raan} {ma} {bstar}"
            if rev_number > 0:
                param += f" RevNumber {rev_number}"
        
        result = self.conn.send_command("SetState", param)
        
        return {
            "status": "success",
            "satellite": name,
            "response": result
        }
    
    def set_satellite_tle(self, name: str,
                           tle_card1: str,
                           tle_card2: str,
                           time_period: Optional[str] = None) -> Dict[str, Any]:
        """
        设置卫星 TLE 状态
        
        参考文档：卫星命令 - SetState TLE
        """
        param = f'*/Satellite/{name} TLE "{tle_card1}" "{tle_card2}"'
        if time_period:
            param += f" TimePeriod {time_period}"
        
        result = self.conn.send_command("SetState", param)
        
        return {
            "status": "success",
            "satellite": name,
            "response": result
        }
    
    def set_satellite_graphics(self, name: str,
                                show: bool = True,
                                label: bool = True,
                                orbit: bool = True,
                                color: int = 15,
                                line_width: float = 2.0) -> Dict[str, Any]:
        """
        设置卫星可视化显示属性
        
        参考文档：卫星命令 - Graphics
        """
        param = f"*/Satellite/{name} Basic"
        param += f" Show {'on' if show else 'off'}"
        param += f" Label {'on' if label else 'off'}"
        param += f" Orbit {'on' if orbit else 'off'}"
        param += f" LineWidth {line_width}"
        param += f" color {color}"
        
        result = self.conn.send_command("Graphics", param)
        
        return {
            "status": "success",
            "satellite": name,
            "response": result
        }
    
    def get_satellite_position(self, name: str, time: Optional[str] = None) -> Dict[str, Any]:
        """
        获取卫星当前位置
        
        参考文档：卫星命令 - Position
        """
        param = f'*/Satellite/{name} "{time}"' if time else f"*/Satellite/{name}"
        
        result = self.conn.send_command("Position", param)
        
        return {
            "status": "success",
            "satellite": name,
            "response": result
        }
    
    # ===== 天体配置 =====
    
    def set_central_body(self, name: str, body_type: str = "CentralBody") -> Dict[str, Any]:
        """
        ⚠️ 已弃用：ATK CONNECT模式下 SetCentralBody 命令不工作。
        
        中心天体必须在 create_scenario 时通过 central_body 参数指定。
        请使用 create_scenario(name, central_body="Moon") 来创建月球场景。
        
        此方法保留仅为向后兼容，实际不会生效。
        """
        return {
            "status": "deprecated",
            "message": "SetCentralBody 在 CONNECT模式下不工作。请使用 create_scenario(central_body='Moon') 创建月球场景。",
            "central_body": name,
            "response": ""
        }
    
    # ===== 地面站操作 =====
    
    def create_facility(self, name: str, lat: float, lon: float, alt_km: float = 0) -> Dict[str, Any]:
        """
        创建地面站
        
        参考文档：地面站命令 - SetPosition
        """
        # 新建地面站
        result = self.conn.send_command("New", f"/ Facility {name}")
        
        # 设置位置
        alt_m = alt_km * 1000
        param = f"*/Facility/{name} Geoditic {lat} {lon} {alt_m}"
        result += self.conn.send_command("SetPosition", param)
        
        return {
            "status": "success",
            "facility": name,
            "response": result
        }
    
    # ===== 仿真控制 =====
    
    def run_simulation(self) -> Dict[str, Any]:
        """
        运行仿真
        
        参考文档：场景命令 - Animate
        用法：atkConnect(conID, 'Animate', '* Start')
        """
        result = self.conn.send_command("Animate", "* Start")
        
        return {
            "status": "success",
            "response": result
        }
    
    def reset_simulation(self) -> Dict[str, Any]:
        """
        重置仿真
        
        参考文档：场景命令 - Animate
        用法：atkConnect(conID, 'Animate', '* Reset')
        """
        result = self.conn.send_command("Animate", "* Reset")
        
        return {
            "status": "success",
            "response": result
        }
    
    # ===== 机动规划 (Astrogator) =====
    
    def set_satellite_astrogator(self, name: str) -> Dict[str, Any]:
        """
        设置卫星为机动规划模式
        
        参考文档：机动规划命令 - SetProp
        """
        result = self.conn.send_command("Astrogator", f"*/Satellite/{name} SetProp")
        
        return {
            "status": "success",
            "satellite": name,
            "response": result
        }
    
    def insert_segment(self, name: str, after_segment: str, new_segment: str) -> Dict[str, Any]:
        """
        插入段到任务控制序列
        
        参考文档：机动规划命令 - InsertSegment
        """
        param = f"*/Satellite/{name} InsertSegment {after_segment} {new_segment}"
        result = self.conn.send_command("Astrogator", param)
        
        return {
            "status": "success",
            "satellite": name,
            "response": result
        }
    
    def set_segment_value(self, name: str, attribute_path: str, value: str) -> Dict[str, Any]:
        """
        设置段属性值
        
        参考文档：机动规划命令 - SetValue
        """
        param = f"*/Satellite/{name} SetValue {attribute_path} {value}"
        result = self.conn.send_command("Astrogator", param)
        
        return {
            "status": "success",
            "satellite": name,
            "response": result
        }
    
    def run_astrogator(self, name: str) -> Dict[str, Any]:
        """
        运行机动规划
        
        参考文档：机动规划命令 - RunMCS
        """
        result = self.conn.send_command("Astrogator", f"*/Satellite/{name} RunMCS")
        
        return {
            "status": "success",
            "satellite": name,
            "response": result
        }
    
    # ===== 批量操作 =====
    
    def create_multiple_satellites(self, names: list) -> Dict[str, Any]:
        """
        批量创建卫星
        
        参考文档：客户端接口 - 新建多个卫星
        """
        param = f"/ Satellite {' '.join(names)}"
        result = self.conn.send_command("NewMulti", param)
        
        return {
            "status": "success",
            "satellites": names,
            "response": result
        }
