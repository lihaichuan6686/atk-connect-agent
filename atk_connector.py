"""
ATK Connector - 基于 ATK 官方 Python 模块 (ATKConnectModule)

使用 ATK 官方接口：atkOpen, atkConnect, atkClose
参考文档：IntegratingWithATK/connect/Python/ATKConnectModule.py

命令格式：atkConnect(conID, 'command obj_path param')
例如：atkConnect(conID, 'New / Scenario Test')
"""
import socket
import time
import subprocess
import os
import sys
from typing import Optional

# ATK Python 模块路径（也可通过环境变量 ATK_PYTHON_PATH 设置）
ATK_PYTHON_PATH = os.environ.get(
    "ATK_PYTHON_PATH",
    r"D:\atk-v4.0.0\atk\ATK-v4.0.0-windows-x64\ATK-4.0.0\IntegratingWithATK\connect\Python"
)

# 尝试导入 ATK 官方模块
_atk_module = None
try:
    if ATK_PYTHON_PATH not in sys.path:
        sys.path.insert(0, ATK_PYTHON_PATH)
    import ATKConnectModule as _atk_module
    print(f"[ATK Connector] 使用 ATK 官方模块: {ATK_PYTHON_PATH}")
except Exception as e:
    print(f"[ATK Connector] ATK 官方模块加载失败: {e}")


class ATKConnector:
    """
    ATK 连接管理器
    
    使用 ATK 官方 ATKConnectModule 接口
    """
    
    def __init__(self, host: str = "127.0.0.1", port: int = 6655):
        self.host = host
        self.port = port
        self.conID = -1
        self.connected = False
        self.use_official = _atk_module is not None
    
    def connect(self) -> bool:
        """
        连接到 ATK
        
        Returns:
            bool: 连接是否成功
        """
        if not self.use_official:
            print("[ATK Connector] ATK 官方模块不可用，无法连接")
            return False
        
        try:
            # 重试连接（ATK 启动需要时间）
            for i in range(15):
                self.conID = _atk_module.atkOpen(self.host, self.port)
                if self.conID > 0:
                    self.connected = True
                    print(f"[ATK Connector] 连接成功, conID={self.conID}")
                    return True
                time.sleep(1)
            
            print(f"[ATK Connector] 连接失败，conID={self.conID}")
            return False
        except Exception as e:
            print(f"[ATK Connector] 连接异常: {e}")
            self.connected = False
            return False
    
    def send_command(self, command: str, param: str = "") -> str:
        """
        发送 ATK 命令

        命令格式：atkConnect(conID, command, param)
        例如：atkConnect(conID, 'New', '/ Scenario Test')
              atkConnect(conID, 'SetAnalysisTimePeriod', '* "5 Nov 2022 00:00:00.000" "8 Nov 2022 00:00:00.000"')
              atkConnect(conID, 'New', '/ Satellite TestSat')
              atkConnect(conID, 'SetState', '*/Satellite/TestSat Cartesian ...')

        参数:
            command: 命令名称（如 New, SetState, Graphics 等）
            param: 参数字符串（包含对象路径和参数）

        Returns:
            str: ATK 返回的响应字符串
        """
        if not self.connected:
            raise RuntimeError("未连接到 ATK")

        if not self.use_official:
            return "ERROR: ATK 官方模块不可用"

        # 验证参数类型
        if not isinstance(command, str):
            error_msg = f"命令必须是字符串类型，当前: {type(command).__name__}"
            print(f"[ATK Connector] {error_msg}")
            return f"ERROR: {error_msg}"
        
        if not isinstance(param, str):
            error_msg = f"参数必须是字符串类型，当前: {type(param).__name__}, 值: {param}"
            print(f"[ATK Connector] {error_msg}")
            return f"ERROR: {error_msg}"
        
        # 清理参数字符串（移除可能导致 ATK 模块格式化错误的字符）
        # ATK 模块内部可能使用 % 格式化，所以 % 字符会导致错误
        if '%' in param:
            print(f"[ATK Connector] 警告: 参数包含 % 字符，可能导致格式化错误")
            print(f"[ATK Connector] 原始参数: {repr(param)}")
            # 转义 % 字符
            param = param.replace('%', '%%')
            print(f"[ATK Connector] 转义后参数: {repr(param)}")

        try:
            result = _atk_module.atkConnect(self.conID, command, param)
            return result if result else ""
        except Exception as e:
            error_msg = f"命令发送失败: {type(e).__name__}: {e}\n命令: {command}\n参数: {param}"
            print(f"[ATK Connector] {error_msg}")
            return f"ERROR: {error_msg}"
    
    def close(self):
        """关闭 ATK 连接"""
        try:
            if self.use_official and self.conID > 0:
                _atk_module.atkClose(self.conID)
                print(f"[ATK Connector] 连接已关闭, conID={self.conID}")
        except:
            pass
        self.connected = False
        self.conID = -1
    
    def __del__(self):
        self.close()


class ATKProcess:
    """
    ATK 进程管理器
    负责启动和关闭 ATK.exe 进程
    """
    
    def __init__(self, exe_path: str):
        self.exe_path = exe_path
        self.process: Optional[subprocess.Popen] = None
    
    def start(self, wait_seconds: int = 8) -> bool:
        """
        启动 ATK 进程
        
        参数:
            wait_seconds: 等待 ATK 启动的秒数
        
        Returns:
            bool: 启动是否成功
        """
        if not os.path.exists(self.exe_path):
            print(f"[ATK Process] ATK 可执行文件不存在: {self.exe_path}")
            return False
        
        try:
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            
            self.process = subprocess.Popen(
                [self.exe_path],
                startupinfo=startupinfo,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
            )
            print(f"[ATK Process] ATK 已启动，PID: {self.process.pid}")
            
            # 等待 ATK 启动完成
            time.sleep(wait_seconds)
            return True
        except Exception as e:
            print(f"[ATK Process] 启动 ATK 失败: {e}")
            return False
    
    def stop(self):
        """关闭 ATK 进程"""
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=5)
            except:
                try:
                    self.process.kill()
                except:
                    pass
            self.process = None
            print("[ATK Process] ATK 已关闭")
    
    def is_running(self) -> bool:
        """检查 ATK 是否正在运行"""
        if self.process is None:
            return False
        return self.process.poll() is None
    
    def __del__(self):
        self.stop()
