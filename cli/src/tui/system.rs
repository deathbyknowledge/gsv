use std::collections::BTreeMap;
use std::time::Instant;

// ── Node info ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct NodeInfo {
    pub node_id: String,
    pub host_role: String,
    pub host_os: String,
    pub tool_count: usize,
    pub tools: Vec<String>,
    pub connected: bool,
}

// ── Channel info ────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct ChannelInfo {
    pub channel: String,
    pub account_id: String,
    pub connected: bool,
    pub connected_at: Option<String>,
}

// ── System state ────────────────────────────────────────────────────────────

pub struct SystemState {
    pub nodes: BTreeMap<String, NodeInfo>,
    pub channels: BTreeMap<String, ChannelInfo>,
    pub last_refresh: Option<Instant>,
}

impl SystemState {
    pub fn new() -> Self {
        Self {
            nodes: BTreeMap::new(),
            channels: BTreeMap::new(),
            last_refresh: None,
        }
    }

    // ── Node events ─────────────────────────────────────────────────

    pub fn node_connected(
        &mut self,
        node_id: &str,
        tool_count: usize,
        host_os: Option<&str>,
        host_role: Option<&str>,
    ) {
        self.nodes.insert(
            node_id.to_string(),
            NodeInfo {
                node_id: node_id.to_string(),
                host_role: host_role.unwrap_or("execution").to_string(),
                host_os: host_os.unwrap_or("?").to_string(),
                tool_count,
                tools: Vec::new(),
                connected: true,
            },
        );
    }

    pub fn node_disconnected(&mut self, node_id: &str) {
        if let Some(node) = self.nodes.get_mut(node_id) {
            node.connected = false;
        }
    }

    // ── Channel events ──────────────────────────────────────────────

    pub fn channel_status(
        &mut self,
        channel: &str,
        account_id: &str,
        connected: bool,
        connected_at: Option<&str>,
    ) {
        let key = format!("{}:{}", channel, account_id);
        if connected {
            self.channels.insert(
                key,
                ChannelInfo {
                    channel: channel.to_string(),
                    account_id: account_id.to_string(),
                    connected,
                    connected_at: connected_at.map(String::from),
                },
            );
        } else if let Some(ch) = self.channels.get_mut(&key) {
            ch.connected = false;
        }
    }

    // ── Populate from polling ───────────────────────────────────────

    pub fn load_from_nodes_list(&mut self, payload: &serde_json::Value) {
        self.nodes.clear();
        if let Some(nodes) = payload.get("nodes").and_then(|v| v.as_array()) {
            for node in nodes {
                let node_id = node.get("nodeId").and_then(|v| v.as_str()).unwrap_or("?");
                let host_role = node
                    .get("hostRole")
                    .and_then(|v| v.as_str())
                    .unwrap_or("execution");
                let host_os = node.get("hostOs").and_then(|v| v.as_str()).unwrap_or("?");
                let tools: Vec<String> = node
                    .get("tools")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();

                self.nodes.insert(
                    node_id.to_string(),
                    NodeInfo {
                        node_id: node_id.to_string(),
                        host_role: host_role.to_string(),
                        host_os: host_os.to_string(),
                        tool_count: tools.len(),
                        tools,
                        connected: true,
                    },
                );
            }
        }
        self.last_refresh = Some(Instant::now());
    }

    pub fn load_from_channels_list(&mut self, payload: &serde_json::Value) {
        self.channels.clear();
        if let Some(channels) = payload.get("channels").and_then(|v| v.as_array()) {
            for ch in channels {
                let channel = ch.get("channel").and_then(|v| v.as_str()).unwrap_or("?");
                let account_id = ch
                    .get("accountId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default");
                let connected_at = ch
                    .get("connectedAt")
                    .and_then(|v| v.as_i64())
                    .and_then(|ts| {
                        chrono::DateTime::from_timestamp_millis(ts)
                            .map(|dt| dt.format("%m-%d %H:%M").to_string())
                    });

                let key = format!("{}:{}", channel, account_id);
                self.channels.insert(
                    key,
                    ChannelInfo {
                        channel: channel.to_string(),
                        account_id: account_id.to_string(),
                        connected: true,
                        connected_at,
                    },
                );
            }
        }
        self.last_refresh = Some(Instant::now());
    }

    // ── Summary for title bar ───────────────────────────────────────

    pub fn summary(&self) -> String {
        let active_nodes = self.nodes.values().filter(|n| n.connected).count();
        let active_channels = self.channels.values().filter(|c| c.connected).count();
        format!("{} nodes  {} ch", active_nodes, active_channels)
    }
}
