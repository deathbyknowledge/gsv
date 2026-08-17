pub use gsv_config::{device_log_path, device_log_pattern};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_log_pattern_points_at_rotated_device_logs() {
        assert!(device_log_pattern().ends_with("device.log*"));
    }
}
