pub use gsv_client::client::*;
pub use gsv_client::{BinaryBodyLimits, ClientIdentity};

pub fn cli_client_identity() -> ClientIdentity {
    ClientIdentity::new(
        format!("gsv-cli-{}", uuid::Uuid::new_v4()),
        crate::build_info::BUILD_VERSION,
    )
    .with_channel("cli")
}
