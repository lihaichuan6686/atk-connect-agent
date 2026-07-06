"""
ATK Agent Configuration
"""
import os

# ATK 安装路径（也可通过环境变量 ATK_EXE_PATH 设置）
ATK_EXE_PATH = os.environ.get(
    "ATK_EXE_PATH",
    r"D:\atk-v4.0.0\atk\ATK-v4.0.0-windows-x64\ATK-4.0.0\ATK.exe"
)

# ATK Connect 连接参数
ATK_HOST = os.environ.get("ATK_HOST", "127.0.0.1")
ATK_PORT = int(os.environ.get("ATK_PORT", "6655"))

# ATK 启动等待时间（秒）
ATK_STARTUP_WAIT = int(os.environ.get("ATK_STARTUP_WAIT", "8"))

# 输出目录
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")

# ========== LLM 配置 ==========
# 优先从环境变量读取，避免 API 密钥泄露到代码仓库
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "deepseek-chat")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com/v1")
LLM_API_URL = f"{LLM_BASE_URL}/chat/completions"
