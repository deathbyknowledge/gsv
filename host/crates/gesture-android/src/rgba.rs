use std::sync::Arc;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackedRgbFrame {
    pub width: u32,
    pub height: u32,
    pub rgb: Arc<[u8]>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FrameError {
    Dimensions,
    Layout,
    Rotation,
}

pub fn rgba_to_oriented_rgb(
    source: &[u8],
    width: u32,
    height: u32,
    row_stride: usize,
    pixel_stride: usize,
    rotation_degrees: i32,
) -> Result<PackedRgbFrame, FrameError> {
    let width = usize::try_from(width).map_err(|_| FrameError::Dimensions)?;
    let height = usize::try_from(height).map_err(|_| FrameError::Dimensions)?;
    if width == 0 || height == 0 || width > 1_920 || height > 1_080 {
        return Err(FrameError::Dimensions);
    }
    if pixel_stride < 4 || row_stride < width.saturating_mul(pixel_stride) {
        return Err(FrameError::Layout);
    }
    let required = height
        .checked_sub(1)
        .and_then(|rows| rows.checked_mul(row_stride))
        .and_then(|offset| {
            width
                .checked_sub(1)
                .and_then(|columns| columns.checked_mul(pixel_stride))
                .and_then(|last_pixel| offset.checked_add(last_pixel))
        })
        .and_then(|offset| offset.checked_add(4))
        .ok_or(FrameError::Layout)?;
    if source.len() < required {
        return Err(FrameError::Layout);
    }

    let (output_width, output_height) = match rotation_degrees {
        0 | 180 => (width, height),
        90 | 270 => (height, width),
        _ => return Err(FrameError::Rotation),
    };
    let output_bytes = output_width
        .checked_mul(output_height)
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or(FrameError::Dimensions)?;
    let mut rgb = vec![0_u8; output_bytes];

    for output_y in 0..output_height {
        for output_x in 0..output_width {
            let (source_x, source_y) = match rotation_degrees {
                0 => (output_x, output_y),
                90 => (output_y, height - 1 - output_x),
                180 => (width - 1 - output_x, height - 1 - output_y),
                270 => (width - 1 - output_y, output_x),
                _ => return Err(FrameError::Rotation),
            };
            let source_offset = source_y * row_stride + source_x * pixel_stride;
            let output_offset = (output_y * output_width + output_x) * 3;
            rgb[output_offset..output_offset + 3]
                .copy_from_slice(&source[source_offset..source_offset + 3]);
        }
    }

    Ok(PackedRgbFrame {
        width: u32::try_from(output_width).map_err(|_| FrameError::Dimensions)?,
        height: u32::try_from(output_height).map_err(|_| FrameError::Dimensions)?,
        rgb: Arc::from(rgb.into_boxed_slice()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(red: u8) -> [u8; 4] {
        [red, red.wrapping_add(40), red.wrapping_add(80), 255]
    }

    fn frame() -> Vec<u8> {
        [pixel(1), pixel(2), pixel(3), pixel(4), pixel(5), pixel(6)].concat()
    }

    fn reds(frame: &PackedRgbFrame) -> Vec<u8> {
        frame
            .rgb
            .as_chunks::<3>()
            .0
            .iter()
            .map(|pixel| pixel[0])
            .collect()
    }

    #[test]
    fn preserves_rgba_channel_order_and_drops_alpha() {
        let packed = rgba_to_oriented_rgb(&pixel(7), 1, 1, 4, 4, 0).expect("valid frame");
        assert_eq!(&*packed.rgb, &[7, 47, 87]);
    }

    #[test]
    fn rotates_sensor_frames_clockwise() {
        let source = frame();
        let ninety = rgba_to_oriented_rgb(&source, 3, 2, 12, 4, 90).expect("valid frame");
        assert_eq!((ninety.width, ninety.height), (2, 3));
        assert_eq!(reds(&ninety), vec![4, 1, 5, 2, 6, 3]);

        let one_eighty = rgba_to_oriented_rgb(&source, 3, 2, 12, 4, 180).expect("valid frame");
        assert_eq!(reds(&one_eighty), vec![6, 5, 4, 3, 2, 1]);

        let two_seventy = rgba_to_oriented_rgb(&source, 3, 2, 12, 4, 270).expect("valid frame");
        assert_eq!(reds(&two_seventy), vec![3, 6, 2, 5, 1, 4]);
    }

    #[test]
    fn accepts_padded_rows_and_rejects_truncated_storage() {
        let mut source = Vec::new();
        source.extend_from_slice(&pixel(1));
        source.extend_from_slice(&pixel(2));
        source.extend_from_slice(&[0; 4]);
        source.extend_from_slice(&pixel(3));
        source.extend_from_slice(&pixel(4));
        let packed = rgba_to_oriented_rgb(&source, 2, 2, 12, 4, 0).expect("valid padding");
        assert_eq!(reds(&packed), vec![1, 2, 3, 4]);
        assert_eq!(
            rgba_to_oriented_rgb(&source[..source.len() - 1], 2, 2, 12, 4, 0),
            Err(FrameError::Layout),
        );
    }
}
