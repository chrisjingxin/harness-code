"""代码智能工具模块：验证 lsp 操作校验、stub 返回和 tool_search 打分逻辑。"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from harness_agent.tools.tools_intelligence import lsp, tool_search


@pytest.mark.asyncio
async def test_lsp_invalid_action():
    """无效 action 应返回错误信息。"""
    result = await lsp("rename", "main.py")

    assert "error" in result
    assert "无效的操作类型" in result["error"]


@pytest.mark.asyncio
async def test_lsp_stub_no_server(tmp_path):
    """未配置 LSP 环境变量时应返回 stub 结果。"""
    target = tmp_path / "main.py"
    target.write_text("print('hello')", encoding="utf-8")

    with patch.dict("os.environ", {}, clear=True):
        result = await lsp("definition", "main.py", line=1, column=1, workspace_root=str(tmp_path))

    assert result["action"] == "definition"
    assert result["file_path"] == "main.py"
    assert result["results"] == []
    assert "LSP 服务未连接" in result["note"]


@pytest.mark.asyncio
async def test_lsp_file_not_found(tmp_path):
    """文件不存在时应返回错误。"""
    with patch.dict("os.environ", {}, clear=True):
        result = await lsp("hover", "nonexistent.py", workspace_root=str(tmp_path))

    assert "error" in result
    assert "文件不存在" in result["error"]


def _mcp_tool(name: str, description: str, hint: str = "github") -> dict[str, object]:
    """构造一个 MCP 风格工具候选（is_mcp=True + search_hint + input_schema）。"""
    return {
        "name": name,
        "description": description,
        "search_hint": hint,
        "is_mcp": True,
        "input_schema": {"type": "object", "properties": {"repo": {"type": "string"}}},
    }


def test_tool_search_empty():
    """无已注册工具时应返回空结果和提示。"""
    result = tool_search("anything")

    assert result["results"] == []
    assert "无已注册的 MCP 工具" in result["note"]


def test_tool_search_empty_query():
    """空白查询应返回提示而不是崩溃。"""
    tools = [_mcp_tool("github_search", "搜索 GitHub 仓库")]
    result = tool_search("   ", available_tools=tools)

    assert result["results"] == []
    assert "查询不能为空" in result["note"]


def test_tool_search_select_exact():
    """select: 模式按名精确返回，忽略缺失名并提示。"""
    tools = [
        _mcp_tool("github_create_issue", "创建 issue"),
        _mcp_tool("github_list_repos", "列出仓库"),
        _mcp_tool("slack_send", "发消息"),
    ]
    result = tool_search("select:github_create_issue,slack_send,missing_tool", available_tools=tools)

    names = [item["name"] for item in result["results"]]
    assert names == ["github_create_issue", "slack_send"]
    assert "missing_tool" in result["note"]


def test_tool_search_select_case_insensitive_dedupe():
    """select: 大小写不敏感且去重。"""
    tools = [_mcp_tool("GitHub_Search", "搜索仓库")]
    result = tool_search("select:github_search,GITHUB_SEARCH", available_tools=tools)

    assert len(result["results"]) == 1
    assert result["results"][0]["name"] == "GitHub_Search"


def test_tool_search_select_no_missing_no_note():
    """select: 全部命中时不带 note 字段。"""
    tools = [_mcp_tool("github_search", "搜索仓库")]
    result = tool_search("select:github_search", available_tools=tools)

    assert len(result["results"]) == 1
    assert "note" not in result


def test_tool_search_bare_name_fast_path():
    """裸工具名与名称完全一致时直接返回（子代理/压缩后常见）。"""
    tools = [
        _mcp_tool("github_create_issue", "创建 issue"),
        _mcp_tool("github_list_repos", "列出仓库"),
    ]
    result = tool_search("github_create_issue", available_tools=tools)

    assert len(result["results"]) == 1
    assert result["results"][0]["name"] == "github_create_issue"


def test_tool_search_keyword_matches_name_part():
    """关键词命中名称部件（server__tool 拆分）优先于描述命中。"""
    tools = [
        _mcp_tool("github_create_issue", "创建 issue"),
        _mcp_tool("slack_send", "发送 GitHub 通知"),
    ]
    result = tool_search("issue", available_tools=tools)

    names = [item["name"] for item in result["results"]]
    assert names[0] == "github_create_issue"


def test_tool_search_mcp_weighs_higher():
    """同层级比较：MCP 工具名称部件命中的权重（6）高于内置工具（5）。"""
    tools = [
        {"name": "myrepo_info", "description": "仓库信息", "is_mcp": False},
        {"name": "github_list_repos", "description": "列出仓库", "is_mcp": True},
    ]
    result = tool_search("repo", available_tools=tools)

    names = [item["name"] for item in result["results"]]
    assert names[0] == "github_list_repos"


def test_tool_search_required_term_filters():
    """+必选词未在名称部件/描述/search_hint 命中时排除候选。"""
    tools = [
        _mcp_tool("github_create_issue", "创建 issue"),
        _mcp_tool("slack_send", "发消息"),
    ]
    # issue 只存在于 github_create_issue 的名称部件；slack_send 的
    # search_hint=github 无法通过 +issue 预筛。
    result = tool_search("+issue 创建", available_tools=tools)

    names = [item["name"] for item in result["results"]]
    assert names == ["github_create_issue"]


def test_tool_search_required_term_allows_hint():
    """+必选词命中 search_hint（服务器名）也通过预筛（参考实现语义）。"""
    tools = [
        _mcp_tool("create_issue", "创建 issue", hint="github"),
        _mcp_tool("slack_send", "发消息", hint="slack"),
    ]
    result = tool_search("+github issue", available_tools=tools)

    names = [item["name"] for item in result["results"]]
    assert "create_issue" in names
    assert "slack_send" not in names


def test_tool_search_word_boundary():
    """ASCII 词匹配使用词边界：git 不命中 digit 的描述（名称部件命中优先）。"""
    tools = [
        _mcp_tool("github_search", "搜索代码"),
        {"name": "digital_clock", "description": "digit 显示时间", "is_mcp": False},
    ]
    result = tool_search("git", available_tools=tools)

    names = [item["name"] for item in result["results"]]
    # github_search 名称部件精确命中（12）排第一；digital_clock 仅靠全名
    # 兜底（3）排后——词边界保证了描述 "digit" 不被误判为 "git"。
    assert names[0] == "github_search"
    assert "digital_clock" not in names[:1]


def test_tool_search_chinese_substring():
    """中文词退化为子串匹配，不应漏掉合法命中。"""
    tools = [_mcp_tool("db_query", "执行数据库查询操作")]
    result = tool_search("数据库", available_tools=tools)

    assert len(result["results"]) == 1
    assert result["results"][0]["name"] == "db_query"


def test_tool_search_stop_words_filtered():
    """停用词被过滤后仍可命中剩余词。"""
    tools = [
        _mcp_tool("web_fetch", "获取网页内容"),
        {"name": "ls", "description": "列出目录", "is_mcp": False},
    ]
    result = tool_search("use web fetch", available_tools=tools)

    names = [item["name"] for item in result["results"]]
    assert names == ["web_fetch"]


def test_tool_search_search_hint_match():
    """search_hint（服务器名）命中应使工具进入结果。"""
    tools = [_mcp_tool("create_issue", "创建 issue", hint="slack")]
    result = tool_search("slack", available_tools=tools)

    assert len(result["results"]) == 1
    assert result["results"][0]["name"] == "create_issue"


def test_tool_search_results_carry_schema_and_hint():
    """结果条目携带 search_hint 与 input_schema。"""
    tools = [_mcp_tool("github_create_issue", "创建 issue")]
    result = tool_search("issue", available_tools=tools)

    entry = result["results"][0]
    assert entry["search_hint"] == "github"
    assert entry["input_schema"]["properties"]["repo"]["type"] == "string"


def test_tool_search_no_match_note():
    """无命中时应返回提示。"""
    tools = [_mcp_tool("github_create_issue", "创建 issue")]
    result = tool_search("数据库查询", available_tools=tools)

    assert result["results"] == []
    assert "未找到匹配工具" in result["note"]


def test_tool_search_limit():
    """搜索结果最多返回 20 条，且按分数降序。"""
    tools = [
        {"name": f"tool_{i}", "description": "通用工具", "is_mcp": False}
        for i in range(30)
    ]
    result = tool_search("工具", available_tools=tools)

    assert len(result["results"]) == 20


def test_tool_search_only_top_hits_carry_schema():
    """D-2：关键词搜索只给头部强匹配带 input_schema，其余给名字+描述省 token。

    deferred 机制目的是省 context，20 条全带 schema 每次搜索烧 6k-16k token，
    机制自我否定。排名分靠后的候选只提供名称与描述，需参数时模型可用
    select:<name> 精确查询取回 schema。
    """
    # 让排名可预期：名称命中的工具分数高于描述命中的工具。
    # 避开停用词（search/find/tool 会被过滤，见 _TOOL_SEARCH_STOP_WORDS）。
    tools = [
        _mcp_tool(f"lookup_repo_{i}", "检索仓库")
        for i in range(8)
    ] + [
        _mcp_tool(f"helper_{i}", "lookup 辅助工具")
        for i in range(8)
    ]
    result = tool_search("lookup", available_tools=tools)

    assert result["results"]
    entries = result["results"]
    with_schema = [e for e in entries if "input_schema" in e]
    without_schema = [e for e in entries if "input_schema" not in e]
    # 只有头部强匹配带 schema（上限 5 条），其余不带
    assert 1 <= len(with_schema) <= 5
    assert without_schema, "非头部命中不应携带 input_schema"
    # 无 schema 的条目仍保留 name/description（reveal 解析依赖 name）
    assert all(e["name"] for e in without_schema)
    # 返回体给出获取完整 schema 的提示
    assert result.get("schema_hint"), "应提示模型用 select 取回完整 schema"


def test_tool_search_select_mode_still_returns_schema():
    """D-2：select: 精确选择是模型点名要 schema 的路径，必须保留完整 schema。"""
    tools = [_mcp_tool("github_create_issue", "创建 issue")]
    result = tool_search("select:github_create_issue", available_tools=tools)

    entry = result["results"][0]
    assert entry["input_schema"]["properties"]["repo"]["type"] == "string"


def test_tool_search_limit_offset_pagination():
    """D-2：limit/offset 分页，返回 hasMore/nextOffset 供翻页。"""
    tools = [
        {"name": f"tool_{i:02d}", "description": "通用工具", "is_mcp": False}
        for i in range(30)
    ]
    page1 = tool_search("工具", available_tools=tools, limit=10)

    assert len(page1["results"]) == 10
    assert page1["total"] == 30
    assert page1["hasMore"] is True
    assert page1["nextOffset"] == 10

    page2 = tool_search("工具", available_tools=tools, limit=10, offset=10)
    assert [e["name"] for e in page2["results"]][0] == "tool_10"

    page3 = tool_search("工具", available_tools=tools, limit=10, offset=20)
    assert len(page3["results"]) == 10
    assert page3["hasMore"] is False
    assert page3["nextOffset"] is None


def test_tool_search_offset_beyond_total_keeps_total():
    """offset 越界仍要带 total/hasMore，不能退化成“关键词没命中”提示。"""
    tools = [
        {"name": f"tool_{i:02d}", "description": "通用工具", "is_mcp": False}
        for i in range(3)
    ]

    out = tool_search("工具", available_tools=tools, limit=10, offset=100)

    assert out["results"] == []
    assert out["total"] == 3
    assert out["hasMore"] is False
    assert out["nextOffset"] is None
    assert "note" not in out


# --- 搜索结果的 mode / reveal 约定：reveal 只照 `reveal` 字段办事，不再猜 ---


def _many_tools(count: int) -> list[dict[str, object]]:
    return [_mcp_tool(f"srv_op{i}", f"op {i}", hint="srv") for i in range(count)]


def test_tool_search_keyword_declares_mode_and_reveal_top_hits():
    """关键词搜索显式声明 mode=keyword，reveal 恰为带 schema 的头部命中。"""
    result = tool_search("srv", available_tools=_many_tools(8))

    assert result["mode"] == "keyword"
    with_schema = [item["name"] for item in result["results"] if "input_schema" in item]
    assert len(with_schema) == 5
    assert result["reveal"] == with_schema


def test_tool_search_keyword_reveal_ignores_missing_schema():
    """头部命中是否 reveal 看排名，不看 input_schema 是否存在。

    取不到 schema 的头部工具照样应当被 reveal，否则它永远只能靠 select: 取回。
    """
    tools = [_mcp_tool("srv_op0", "op 0", hint="srv"), _mcp_tool("srv_op1", "op 1", hint="srv")]
    tools[0]["input_schema"] = None

    result = tool_search("srv", available_tools=tools)

    assert set(result["reveal"]) == {"srv_op0", "srv_op1"}


def test_tool_search_select_declares_mode_and_reveals_all_named():
    """select: 是点名取用，mode=select，所有命中都 reveal。"""
    tools = [_mcp_tool("srv_a", "a"), _mcp_tool("srv_b", "b")]

    result = tool_search("select:srv_a,srv_b", available_tools=tools)

    assert result["mode"] == "select"
    assert result["reveal"] == ["srv_a", "srv_b"]


def test_tool_search_bare_name_declares_select_mode():
    """裸名快路径与 select: 同属点名取用。"""
    result = tool_search("srv_a", available_tools=[_mcp_tool("srv_a", "a")])

    assert result["mode"] == "select"
    assert result["reveal"] == ["srv_a"]


def test_tool_search_second_page_reveals_nothing():
    """翻到第二页的结果没有 schema，也不 reveal；模型要用就 select:。"""
    result = tool_search("srv", available_tools=_many_tools(30), offset=20)

    assert result["mode"] == "keyword"
    assert result["reveal"] == []


def test_tool_search_schema_hint_only_when_results_were_trimmed():
    """schema_hint 只在确有结果被省略 schema 时出现；取不到 schema 的头部命中不算。"""
    tools = [_mcp_tool("srv_op0", "op 0", hint="srv"), _mcp_tool("srv_op1", "op 1", hint="srv")]
    tools[0]["input_schema"] = None

    assert "schema_hint" not in tool_search("srv", available_tools=tools)
    assert "schema_hint" in tool_search("srv", available_tools=_many_tools(8))


# --- 不可用服务器提示：搜不到时别让模型以为"没有这个工具" ---


def test_tool_search_no_tools_mentions_unavailable_servers():
    """所有服务器都没连上时，note 要点出服务器名，而不是只说"无已注册"。"""
    result = tool_search("anything", unavailable_servers={"github": "failed", "slack": "failed"})

    assert result["results"] == []
    assert "github" in result["note"] and "slack" in result["note"]


def test_tool_search_no_match_mentions_unavailable_servers():
    """有候选但没命中时，若有服务器不可用，提示里要带上它们。"""
    tools = [_mcp_tool("srv_a", "a")]

    result = tool_search("zzzqqq", available_tools=tools, unavailable_servers={"github": "failed"})

    assert result["results"] == []
    assert "github" in result["note"]


def test_tool_search_without_unavailable_servers_keeps_original_notes():
    """没有不可用服务器时，提示文案保持不变。"""
    assert "github" not in tool_search("anything")["note"]
    assert tool_search("zzzqqq", available_tools=[_mcp_tool("srv_a", "a")])["note"] == "未找到匹配工具，可尝试更宽泛的关键词"


def test_tool_search_unavailable_note_distinguishes_failed_from_skipped():
    """连接失败与缺环境变量的处理方式不同，提示要分别说清，不能都写"检查连接"。"""
    result = tool_search(
        "anything",
        unavailable_servers={"github": "failed", "slack": "skipped"},
    )

    note = result["note"]
    assert "连接失败" in note and "github" in note
    assert "环境变量" in note and "slack" in note


def test_tool_search_unavailable_note_omits_absent_category():
    """只有一类不可用时，不出现另一类的说明。"""
    note = tool_search("anything", unavailable_servers={"github": "failed"})["note"]

    assert "环境变量" not in note


# --- server 过滤 ---


def _server_tool(name: str, server: str | None, description: str = "d") -> dict:
    entry = {"name": name, "description": description, "is_mcp": True}
    if server is not None:
        entry["server"] = server
        entry["search_hint"] = server
    return entry


def test_tool_search_server_filter_keeps_only_that_servers_tools():
    """server 过滤按真实归属，而不是工具名前缀：my_server_search 不属于服务器 my。"""
    tools = [
        _server_tool("my_server_search", "my", "read docs"),
        _server_tool("my_server_search_x", "my_server", "read docs"),
    ]

    result = tool_search("docs", available_tools=tools, server="my")

    assert [r["name"] for r in result["results"]] == ["my_server_search"]
    assert result["reveal"] == ["my_server_search"]


def test_tool_search_results_carry_server_name():
    """结果带上所属服务器，模型才知道下一次可以用哪个值过滤。"""
    result = tool_search("ping", available_tools=[_server_tool("a_ping", "a")])

    assert result["results"][0]["server"] == "a"


def test_tool_search_server_filter_is_case_insensitive():
    result = tool_search("ping", available_tools=[_server_tool("a_ping", "GitHub")], server="github")

    assert [r["name"] for r in result["results"]] == ["a_ping"]


def test_tool_search_server_filter_unknown_server_lists_known_ones():
    """服务器名写错时，告诉模型有哪些服务器，而不是只说"没找到"。"""
    tools = [_server_tool("a_ping", "alpha"), _server_tool("b_ping", "beta")]

    result = tool_search("ping", available_tools=tools, server="gamma")

    assert result["results"] == []
    assert "gamma" in result["note"]
    assert "alpha" in result["note"] and "beta" in result["note"]


def test_tool_search_server_filter_on_unavailable_server_says_so():
    """被过滤的服务器正好连不上时，note 要点明原因，别让模型以为它没有工具。"""
    tools = [_server_tool("a_ping", "alpha")]

    result = tool_search(
        "ping",
        available_tools=tools,
        server="github",
        unavailable_servers={"github": "failed"},
    )

    assert result["results"] == []
    assert "github" in result["note"] and "连接失败" in result["note"]


def test_tool_search_server_filter_applies_to_select_mode():
    tools = [_server_tool("a_ping", "alpha"), _server_tool("b_ping", "beta")]

    result = tool_search("select:a_ping,b_ping", available_tools=tools, server="alpha")

    assert [r["name"] for r in result["results"]] == ["a_ping"]
    assert "b_ping" in result["note"]


def test_tool_search_server_filter_excludes_builtin_tools():
    """内置延迟工具没有所属服务器，指定 server 时不应混进结果。"""
    tools = [
        _server_tool("a_ping", "alpha", "ping"),
        {"name": "web_search", "description": "ping the web", "is_mcp": False},
    ]

    result = tool_search("ping", available_tools=tools, server="alpha")

    assert [r["name"] for r in result["results"]] == ["a_ping"]


def test_tool_search_server_filter_excludes_unmarked_tools():
    """没有归属标记的工具不靠猜名字前缀，指定 server 时一律不匹配。"""
    result = tool_search("ping", available_tools=[_server_tool("a_ping", None)], server="a")

    assert result["results"] == []
