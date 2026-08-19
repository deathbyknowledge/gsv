#[test]
fn test_config_load_default() {
    let cfg = gsv::config::CliConfig::load();

    assert_eq!(cfg.default_session(), "agent:main:cli:dm:main");
    let url = cfg.gateway_url();
    assert!(url.starts_with("ws://") || url.starts_with("wss://"));
}

#[test]
fn test_config_sample() {
    let sample = gsv::config::sample_config();

    assert!(sample.contains("[gateway]"));
    assert!(sample.contains("[r2]"));
    assert!(sample.contains("[session]"));
}
