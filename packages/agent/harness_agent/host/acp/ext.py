"""ACP 扩展命名空间常量（`harnessCode`）。

【这是做什么的？】
定义 Harness 自有的 ACP 扩展标识。两处对外可见：
1. `_meta.harnessCode`：能力协商与逐条 update 的扩展字段容器；
2. `_harnessCode/<方法名>`：`ext_method` / `ext_notification` 的方法前缀。

【上下游】
下游使用者是 `server.py`（S2 声明扩展能力）与 `permissions.py`（S2 下发审批细节）。
S1 只有常量，没有使用方，但测试锁住"前缀由键推导"，避免将来只改一个。
"""

from __future__ import annotations

from typing import Final

EXT_KEY: Final = "harnessCode"
"""扩展字段键名；出现在 `_meta` 与能力声明里，属于对外线上契约。"""

EXT_METHOD_PREFIX: Final = f"_{EXT_KEY}/"
"""自定义 JSON-RPC 方法前缀；ACP 约定扩展方法以 `_` 开头。"""

__all__ = ["EXT_KEY", "EXT_METHOD_PREFIX"]
