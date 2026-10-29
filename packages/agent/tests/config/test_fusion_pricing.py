import pytest
from harness_agent.config.model_pricing import parse_model_pricing


@pytest.mark.parametrize(
    "value",
    [
        {"currency": "USD", "input_per_million": -1},
        {"currency": "USD", "input_per_million": True},
        {"currency": "USD", "input_per_million": float("inf")},
        {"currency": "usd", "input_per_million": 1},
        {"currency": "USD", "other": 1},
    ],
)
def test_price_rejects_invalid_or_ambiguous_fields(value):
    with pytest.raises(ValueError):
        parse_model_pricing(value)


def test_optional_prices_and_missing_cache_price_are_distinct():
    assert parse_model_pricing(None) is None
    p = parse_model_pricing(
        {"currency": "USD", "input_per_million": 2, "output_per_million": 6}
    )
    assert p.to_record() == {
        "currency": "USD",
        "input_per_million": "2",
        "output_per_million": "6",
        "cached_input_per_million": None,
    }


def test_profile_pricing_is_parsed_outside_model_client_settings(tmp_path):
    from tests.config.test_fusion_config import MODELS, _write
    from harness_agent.config.config import load_config

    path = _write(
        tmp_path / "price.toml",
        MODELS
        + '\n[models.profiles.fast.pricing]\ncurrency="USD"\ninput_per_million=2\noutput_per_million=6\n',
    )
    config = load_config(
        workspace=tmp_path, home=tmp_path / "home", config_path=path, environ={}
    )
    profile = config.require_model_profile("fast")
    assert profile.pricing.input_per_million == 2
    assert not hasattr(profile.settings, "pricing")
