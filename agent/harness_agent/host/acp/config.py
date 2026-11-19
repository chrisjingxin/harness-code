"""ACP 会话配置项：模型与工作流。

【这是做什么的？】
把 Host 的模型目录收成 ACP 的 select，供 `session/new` 和 `session/set_config_option` 使用。

【上下游】
- 上游：`server.py` 在建会话和改配置时调用。
- 下游：只依赖官方 SDK 的 schema，不读 Host、不碰连接环境。

目录为空时不给模型项，避免客户端选一个并不存在的模型。工作流始终有两项：
直接执行（build）和分阶段协作（compose）。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from acp.schema import SessionConfigOptionSelect, SessionConfigSelectOption

MODEL_CONFIG_ID = "model"
WORKFLOW_CONFIG_ID = "workflow"
_WORKFLOW_VALUES = ("build", "compose")


def build_config_options(
    profiles: Sequence[Mapping[str, object]],
    *,
    selected_model: str | None,
    last_profile: str | None,
    workflow: str,
) -> list[SessionConfigOptionSelect]:
    """组装当前会话的全部配置项。

    模型当前值的优先级：这次会话里用户选过的 → 该线程上次运行的 profile → 目录默认项。
    `description` 放 provider 标签，测试客户端用它拼状态栏上的「id · 模型名」。
    """
    options: list[SessionConfigOptionSelect] = []
    model = _model_option(profiles, selected_model=selected_model, last_profile=last_profile)
    if model is not None:
        options.append(model)
    current_workflow = workflow if workflow in _WORKFLOW_VALUES else "build"
    options.append(
        SessionConfigOptionSelect(
            id=WORKFLOW_CONFIG_ID,
            name="工作流",
            type="select",
            category={"id": "harness.workflow"},
            current_value=current_workflow,
            options=[
                SessionConfigSelectOption(value="build", name="直接执行"),
                SessionConfigSelectOption(value="compose", name="分阶段协作"),
            ],
        )
    )
    return options


def option_values(option: SessionConfigOptionSelect) -> set[str]:
    """取出一个 select 里所有可选值。"""
    values: set[str] = set()
    for item in option.options:
        value = getattr(item, "value", None)
        if isinstance(value, str):
            values.add(value)
    return values


def _model_option(
    profiles: Sequence[Mapping[str, object]],
    *,
    selected_model: str | None,
    last_profile: str | None,
) -> SessionConfigOptionSelect | None:
    """目录为空或字段残缺时返回 None，调用方就不广告模型项。"""
    choices: list[SessionConfigSelectOption] = []
    ids: list[str] = []
    default_id: str | None = None
    for profile in profiles:
        profile_id = profile.get("id")
        model_name = profile.get("model")
        if not isinstance(profile_id, str) or not profile_id:
            continue
        if not isinstance(model_name, str) or not model_name:
            continue
        ids.append(profile_id)
        if profile.get("is_default") is True:
            default_id = profile_id
        label = profile.get("provider_label")
        choices.append(
            SessionConfigSelectOption(
                value=profile_id,
                name=model_name,
                description=label if isinstance(label, str) and label else None,
            )
        )
    if not choices:
        return None
    current = selected_model if selected_model in ids else None
    if current is None and last_profile in ids:
        current = last_profile
    if current is None:
        current = default_id or ids[0]
    return SessionConfigOptionSelect(
        id=MODEL_CONFIG_ID,
        name="模型",
        type="select",
        category="model",
        current_value=current,
        options=choices,
    )
