pub use gateway_client::client::*;
pub use gateway_client::{BinaryBodyLimits, PeerIdentity};

pub fn cli_peer_identity() -> PeerIdentity {
    PeerIdentity::new(
        format!("gsv-cli-{}", uuid::Uuid::new_v4()),
        crate::build_info::BUILD_VERSION,
    )
}
