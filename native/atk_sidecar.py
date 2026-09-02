#!/usr/bin/env python3
"""
ATK Sidecar — Python 子进程，通过 JSON-RPC over stdio 桥接 ATK 官方 ATKConnectModule。

通信协议:
  请求 (stdin, 每行一个 JSON):
    {"id": 1, "method": "open", "params": {"host": "127.0.0.1", "port": 6655}}
    {"id": 2, "method": "connect", "params": {"conId": 1, "command": "New", "param": "/ Scenario Test"}}
    {"id": 3, "method": "close", "params": {"conId": 1}}

  响应 (stdout, 每行一个 JSON):
    {"id": 1, "result": {"conId": 1, "success": true}}
    {"id": 2, "result": {"response": "...", "success": true}}
    {"id": 3, "error": {"message": "..."}}

  日志输出到 stderr（不干扰 stdout 的 JSON 通信）。
"""

import sys
import os
import json
import time
import traceback

# ============================================================
# 加载 ATK 官方 Python 模块
# ============================================================

_atk_module = None

def load_atk_module():
    """加载 ATKConnectModule"""
    global _atk_module
    if _atk_module is not None:
        return _atk_module

    # 从环境变量获取 ATK Python 模块路径
    module_path = os.environ.get("ATK_PYTHON_PATH", "")
    if not module_path:
        raise RuntimeError("ATK_PYTHON_PATH 环境变量未设置")

    if module_path not in sys.path:
        sys.path.insert(0, module_path)

    try:
        import ATKConnectModule as _atk_module
        log(f"ATK 模块加载成功: {module_path}")
        return _atk_module
    except Exception as e:
        raise RuntimeError(f"ATK 模块加载失败 ({module_path}): {e}")


def log(message):
    """日志输出到 stderr"""
    print(f"[sidecar] {message}", file=sys.stderr, flush=True)


# ============================================================
# JSON-RPC 请求处理
# ============================================================

def handle_request(request):
    """处理单个 JSON-RPC 请求，返回响应字典"""
    req_id = request.get("id")
    method = request.get("method", "")
    params = request.get("params", {})

    try:
        if method == "ping":
            return {"id": req_id, "result": {"status": "ok", "time": time.time()}}

        if method == "open":
            return handle_open(req_id, params)

        if method == "connect":
            return handle_connect(req_id, params)

        if method == "batch_connect":
            return handle_batch_connect(req_id, params)

        if method == "close":
            return handle_close(req_id, params)

        return {"id": req_id, "error": {"message": f"未知方法: {method}"}}

    except Exception as e:
        log(f"处理请求失败: {method}\n{traceback.format_exc()}")
        return {"id": req_id, "error": {"message": str(e)}}


def handle_open(req_id, params):
    """连接到 ATK"""
    host = params.get("host", "127.0.0.1")
    port = params.get("port", 6655)
    max_retries = params.get("maxRetries", 15)

    module = load_atk_module()

    con_id = -1
    for i in range(max_retries):
        con_id = module.atkOpen(host, port)
        if con_id > 0:
            log(f"ATK 连接成功, conId={con_id}")
            return {"id": req_id, "result": {"conId": con_id, "success": True}}
        time.sleep(1)

    log(f"ATK 连接失败, conId={con_id}")
    return {"id": req_id, "result": {"conId": con_id, "success": False}}


def handle_connect(req_id, params):
    """发送 ATK 命令"""
    con_id = params.get("conId", -1)
    command = params.get("command", "")
    param = params.get("param", "")

    if not isinstance(command, str):
        return {"id": req_id, "error": {"message": f"command 必须是字符串, 当前: {type(command).__name__}"}}
    if not isinstance(param, str):
        return {"id": req_id, "error": {"message": f"param 必须是字符串, 当前: {type(param).__name__}"}}

    module = load_atk_module()

    # 转义 % 字符（ATK 模块内部使用 % 格式化会导致错误）
    if "%" in param:
        log(f"警告: 参数包含 % 字符，进行转义")
        param = param.replace("%", "%%")

    try:
        result = module.atkConnect(con_id, command, param)
        response = str(result) if result else ""
        normalized = response.strip().upper()
        success = not (normalized.startswith("NACK") or normalized.startswith("ERROR"))
        return {"id": req_id, "result": {"response": response, "success": success}}
    except Exception as e:
        return {"id": req_id, "result": {"response": f"ERROR: {e}", "success": False}}


def handle_close(req_id, params):
    """关闭 ATK 连接"""
    con_id = params.get("conId", -1)

    module = load_atk_module()

    try:
        module.atkClose(con_id)
        log(f"ATK 连接已关闭, conId={con_id}")
        return {"id": req_id, "result": {"success": True}}
    except Exception:
        # 关闭失败不影响退出
        return {"id": req_id, "result": {"success": True}}


def handle_batch_connect(req_id, params):
    """在同一个 Python/CONNECT 进程内顺序执行批量命令。"""
    con_id = params.get("conId", -1)
    commands = params.get("commands", [])
    stop_on_error = bool(params.get("stopOnError", True))
    if not isinstance(commands, list):
        return {"id": req_id, "error": {"message": "commands 必须是数组"}}
    started = time.time()
    results = []
    succeeded = 0
    failed = 0
    for index, item in enumerate(commands):
        if not isinstance(item, dict):
            result = {"index": index, "success": False, "response": "ERROR: command item 必须是对象"}
        else:
            response = handle_connect(req_id, {
                "conId": con_id,
                "command": item.get("command", ""),
                "param": item.get("param", ""),
            })
            payload = response.get("result", {})
            result = {"index": index, "command": item.get("command", ""), "param": item.get("param", ""), **payload}
        results.append(result)
        if result.get("success"):
            succeeded += 1
        else:
            failed += 1
            if stop_on_error:
                break
        if index == 0 or (index + 1) % 25 == 0 or index + 1 == len(commands):
            sys.stdout.write(json.dumps({"id": None, "result": {
                "type": "progress", "completed": index + 1, "total": len(commands),
                "succeeded": succeeded, "failed": failed,
            }}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    return {"id": req_id, "result": {
        "success": failed == 0,
        "succeeded": succeeded,
        "failed": failed,
        "completed": len(results),
        "total": len(commands),
        "durationMs": int((time.time() - started) * 1000),
        "results": results,
    }}


# ============================================================
# 主循环
# ============================================================

def main():
    log("ATK Sidecar 启动")

    # 确保 stdout 是无缓冲的
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)

    # 发送就绪信号
    sys.stdout.write(json.dumps({"id": 0, "result": {"status": "ready"}}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            sys.stdout.write(json.dumps({
                "id": None,
                "error": {"message": f"JSON 解析失败: {e}"}
            }) + "\n")
            sys.stdout.flush()
            continue

        response = handle_request(request)
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    log("ATK Sidecar 退出")


if __name__ == "__main__":
    main()
