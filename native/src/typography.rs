use gpui::{font, px, FontWeight, SharedString, TextRun, Window};

use crate::theme;

const MAX_TYPE_SIZE: f32 = 72.0;
const MIN_TYPE_SIZE: f32 = 28.0;
const TYPE_STEP: f32 = 2.0;
const MINIMUM_OVERFLOW_PROBE_RATIO: f32 = 0.85;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TypeLayout {
    pub size: f32,
    pub line_height: f32,
    pub width: f32,
    pub content_height: f32,
    pub scrolls: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct FittedSize {
    size: f32,
    content_height: f32,
    fits: bool,
}

pub fn fit_type_layout(
    window: &Window,
    text: &str,
    available_width: f32,
    available_height: f32,
    maximum_size: Option<f32>,
    weight: FontWeight,
) -> TypeLayout {
    let width = reading_width(text, available_width);
    let maximum_size = maximum_size
        .unwrap_or(MAX_TYPE_SIZE)
        .clamp(MIN_TYPE_SIZE, MAX_TYPE_SIZE);
    let maximum_size = quantize_size(maximum_size);
    let text: SharedString = if text.is_empty() {
        " ".into()
    } else {
        text.to_string().into()
    };
    let mut prose_font = font(theme::PROSE_FONT);
    prose_font.weight = weight;

    let mut measured_minimum = None;
    let mut measure_height = |size| {
        if size == MIN_TYPE_SIZE {
            if let Some(height) = measured_minimum {
                return height;
            }
        }
        let line_height = line_height_for(size);
        let height = measured_height(
            window,
            text.clone(),
            prose_font.clone(),
            size,
            line_height,
            width,
        )
        .unwrap_or_else(|| estimated_height(text.as_ref(), size, line_height, width));
        if size == MIN_TYPE_SIZE {
            measured_minimum = Some(height);
        }
        height
    };
    let minimum_overflows = should_probe_minimum(text.as_ref(), width, available_height)
        && measure_height(MIN_TYPE_SIZE) > available_height;
    let fitted = if minimum_overflows {
        FittedSize {
            size: MIN_TYPE_SIZE,
            content_height: measured_minimum.expect("the minimum size was measured"),
            fits: false,
        }
    } else {
        find_fitted_size(maximum_size, available_height, measure_height)
    };

    TypeLayout {
        size: fitted.size,
        line_height: line_height_for(fitted.size),
        width,
        content_height: fitted.content_height,
        scrolls: !fitted.fits,
    }
}

fn should_probe_minimum(text: &str, width: f32, available_height: f32) -> bool {
    estimated_height(text, MIN_TYPE_SIZE, line_height_for(MIN_TYPE_SIZE), width)
        >= available_height * MINIMUM_OVERFLOW_PROBE_RATIO
}

// GPUI's measured height is monotonic while the line-height multiplier is fixed. Search those
// bands independently because the multiplier drops at the policy boundaries below.
fn find_fitted_size(
    maximum_size: f32,
    available_height: f32,
    mut measure_height: impl FnMut(f32) -> f32,
) -> FittedSize {
    let mut band_maximum = maximum_size;

    loop {
        let band_minimum = line_height_band_minimum(band_maximum);
        let maximum_height = if band_maximum == maximum_size {
            let content_height = measure_height(band_maximum);
            if content_height <= available_height {
                return FittedSize {
                    size: band_maximum,
                    content_height,
                    fits: true,
                };
            }
            Some(content_height)
        } else {
            None
        };

        let minimum_height = if band_minimum == band_maximum {
            maximum_height.unwrap_or_else(|| measure_height(band_minimum))
        } else {
            measure_height(band_minimum)
        };
        if minimum_height <= available_height {
            let mut fitting_step = 0_u32;
            let maximum_step = ((band_maximum - band_minimum) / TYPE_STEP) as u32;
            let mut overflowing_step = maximum_step + u32::from(maximum_height.is_none());
            let mut fitted = FittedSize {
                size: band_minimum,
                content_height: minimum_height,
                fits: true,
            };

            while overflowing_step - fitting_step > 1 {
                let candidate_step = (fitting_step + overflowing_step) / 2;
                let candidate_size = band_minimum + candidate_step as f32 * TYPE_STEP;
                let candidate_height = measure_height(candidate_size);
                if candidate_height <= available_height {
                    fitting_step = candidate_step;
                    fitted = FittedSize {
                        size: candidate_size,
                        content_height: candidate_height,
                        fits: true,
                    };
                } else {
                    overflowing_step = candidate_step;
                }
            }

            return fitted;
        }

        if band_minimum == MIN_TYPE_SIZE {
            return FittedSize {
                size: band_minimum,
                content_height: minimum_height,
                fits: false,
            };
        }

        band_maximum = band_minimum - TYPE_STEP;
    }
}

fn line_height_band_minimum(size: f32) -> f32 {
    let line_height = line_height_for(size);
    let mut minimum = size;
    while minimum > MIN_TYPE_SIZE {
        let candidate = (minimum - TYPE_STEP).max(MIN_TYPE_SIZE);
        if line_height_for(candidate) != line_height {
            break;
        }
        minimum = candidate;
    }
    minimum
}

fn measured_height(
    window: &Window,
    text: SharedString,
    prose_font: gpui::Font,
    size: f32,
    line_height: f32,
    width: f32,
) -> Option<f32> {
    let run = TextRun {
        len: text.len(),
        font: prose_font,
        color: theme::color(theme::TEXT),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let shaped = window
        .text_system()
        .shape_text(text, px(size), &[run], Some(px(width)), None)
        .ok()?;
    let line_height = px(size * line_height);
    Some(
        shaped
            .iter()
            .map(|line| f32::from(line.size(line_height).height))
            .sum(),
    )
}

fn estimated_height(text: &str, size: f32, line_height: f32, width: f32) -> f32 {
    let average_glyph_width = size * 0.52;
    let characters_per_line = (width / average_glyph_width).max(1.0);
    let soft_lines = text
        .lines()
        .map(|line| {
            (line.chars().count() as f32 / characters_per_line)
                .ceil()
                .max(1.0)
        })
        .sum::<f32>()
        .max(1.0);
    soft_lines * size * line_height
}

fn reading_width(text: &str, available_width: f32) -> f32 {
    let characters = text.chars().count() as f32;
    let medium = ((characters - 96.0) / 224.0).clamp(0.0, 1.0);
    let long = ((characters - 320.0) / 320.0).clamp(0.0, 1.0);
    let preferred = 820.0 + medium * 100.0 + long * 100.0;
    preferred.min(available_width.max(1.0))
}

fn quantize_size(size: f32) -> f32 {
    (size / TYPE_STEP).floor() * TYPE_STEP
}

fn line_height_for(size: f32) -> f32 {
    if size <= 32.0 {
        1.34
    } else if size <= 44.0 {
        1.26
    } else if size <= 60.0 {
        1.18
    } else {
        1.11
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linearly_fitted_size(
        maximum_size: f32,
        available_height: f32,
        measure_height: impl Fn(f32) -> f32,
    ) -> FittedSize {
        let mut size = maximum_size;
        loop {
            let content_height = measure_height(size);
            let fits = content_height <= available_height;
            if fits || size == MIN_TYPE_SIZE {
                return FittedSize {
                    size,
                    content_height,
                    fits,
                };
            }
            size -= TYPE_STEP;
        }
    }

    #[test]
    fn reading_measure_expands_smoothly_and_respects_the_viewport() {
        assert_eq!(reading_width("short", 1_200.0), 820.0);
        assert!(reading_width(&"a".repeat(200), 1_200.0) > 820.0);
        assert!(reading_width(&"a".repeat(200), 1_200.0) < 920.0);
        assert_eq!(reading_width(&"a".repeat(320), 1_200.0), 920.0);
        assert_eq!(reading_width(&"a".repeat(640), 1_200.0), 1_020.0);
        assert_eq!(reading_width(&"a".repeat(640), 640.0), 640.0);
    }

    #[test]
    fn type_sizes_stay_on_stable_even_steps() {
        assert_eq!(quantize_size(71.9), 70.0);
        assert_eq!(quantize_size(28.0), 28.0);
    }

    #[test]
    fn long_copy_has_more_leading() {
        assert!(line_height_for(28.0) > line_height_for(72.0));
    }

    #[test]
    fn banded_search_preserves_linear_fit_at_leading_boundaries() {
        for maximum_size in (28..=72).step_by(2).map(|size| size as f32) {
            for available_height in (0..=10_000).step_by(5).map(|height| height as f32 / 10.0) {
                let measure_height = |size: f32| {
                    let wrapped_lines = (size * 7.0 / 120.0).ceil().max(1.0);
                    wrapped_lines * size * line_height_for(size)
                };
                let expected = linearly_fitted_size(maximum_size, available_height, measure_height);
                let actual = find_fitted_size(maximum_size, available_height, measure_height);
                assert_eq!(actual, expected);
            }
        }
    }

    #[test]
    fn banded_search_limits_cold_measurements() {
        let mut fitting_measurements = 0;
        let fitted = find_fitted_size(MAX_TYPE_SIZE, f32::MAX, |_| {
            fitting_measurements += 1;
            1.0
        });
        assert_eq!(fitted.size, MAX_TYPE_SIZE);
        assert_eq!(fitting_measurements, 1);

        let mut overflowing_measurements = 0;
        let overflowing = find_fitted_size(MAX_TYPE_SIZE, -1.0, |_| {
            overflowing_measurements += 1;
            1.0
        });
        assert_eq!(overflowing.size, MIN_TYPE_SIZE);
        assert!(!overflowing.fits);
        assert_eq!(overflowing_measurements, 5);

        for available_height in (0..=10_000).step_by(5).map(|height| height as f32 / 10.0) {
            let mut cold_measurements = 0;
            find_fitted_size(MAX_TYPE_SIZE, available_height, |size| {
                cold_measurements += 1;
                let wrapped_lines = (size * 7.0 / 120.0).ceil().max(1.0);
                wrapped_lines * size * line_height_for(size)
            });
            assert!(cold_measurements <= 7);
        }
    }

    #[test]
    fn long_copy_probes_the_final_overflow_size_first() {
        assert!(should_probe_minimum(
            &"A measured response. ".repeat(160),
            1_020.0,
            614.0,
        ));
        assert!(!should_probe_minimum("A short response.", 1_020.0, 614.0,));
    }
}
