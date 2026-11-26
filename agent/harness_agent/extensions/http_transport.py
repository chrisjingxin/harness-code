"""模型与 MCP 共用的 URL 路由判断；不依赖任何模型、MCP SDK 或运行时状态。

只按 URL 中明确的本机地址决定是否绕过系统代理，不做 DNS 查询或授权判断。
"""

from ipaddress import ip_address
from urllib.parse import urlsplit


def is_loopback_endpoint(url: str) -> bool:
    """localhost 或字面回环 IP 可直连；私网及相似域名仍保留企业代理。"""
    hostname = urlsplit(url).hostname
    if hostname is None:
        return False
    if hostname.lower() == "localhost":
        return True
    try:
        return ip_address(hostname).is_loopback
    except ValueError:
        return False
