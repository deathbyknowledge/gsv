use gpui::{font, px, FontWeight, SharedString, TextRun, Window};

use crate::theme;

const MAX_TYPE_SIZE: f32 = 54.0;
const MIN_TYPE_SIZE: f32 = 24.0;
const MIN_PREFERRED_TYPE_SIZE: f32 = 30.0;
const MAX_PREFERRED_TYPE_SIZE: f32 = 42.0;
const MAX_CONTENT_OCCUPANCY: f32 = 0.78;
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
    text: SharedString,
    available_width: f32,
    available_height: f32,
    maximum_size: Option<f32>,
    weight: FontWeight,
) -> TypeLayout {
    let width = reading_width(text.as_ref(), available_width);
    let maximum_size = type_size_ceiling(
        text.as_ref(),
        width,
        available_width,
        available_height,
        maximum_size,
    );
    let fitting_height = available_height * MAX_CONTENT_OCCUPANCY;
    let text: SharedString = if text.is_empty() { " ".into() } else { text };
    let mut prose_font = font(theme::PROSE_FONT);
    prose_font.weight = weight;

    let estimated_minimum = estimated_height(
        text.as_ref(),
        MIN_TYPE_SIZE,
        line_height_for(MIN_TYPE_SIZE),
        width,
    );
    if estimated_minimum > fitting_height {
        return TypeLayout {
            size: MIN_TYPE_SIZE,
            line_height: line_height_for(MIN_TYPE_SIZE),
            width,
            content_height: estimated_minimum,
            scrolls: estimated_minimum > available_height,
        };
    }

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
    let minimum_overflows = should_probe_minimum(text.as_ref(), width, fitting_height)
        && measure_height(MIN_TYPE_SIZE) > fitting_height;
    let fitted = if minimum_overflows {
        FittedSize {
            size: MIN_TYPE_SIZE,
            content_height: measured_minimum.expect("the minimum size was measured"),
            fits: false,
        }
    } else {
        find_fitted_size(maximum_size, fitting_height, measure_height)
    };

    TypeLayout {
        size: fitted.size,
        line_height: line_height_for(fitted.size),
        width,
        content_height: fitted.content_height,
        scrolls: fitted.content_height > available_height,
    }
}

pub fn measure_type_layout_at_size(
    window: &Window,
    text: SharedString,
    available_width: f32,
    available_height: f32,
    size: f32,
    weight: FontWeight,
) -> TypeLayout {
    let width = reading_width(text.as_ref(), available_width);
    let size = quantize_size(size.clamp(MIN_TYPE_SIZE, MAX_TYPE_SIZE));
    let text: SharedString = if text.is_empty() { " ".into() } else { text };
    let mut prose_font = font(theme::PROSE_FONT);
    prose_font.weight = weight;
    let line_height = line_height_for(size);
    let (content_height, _) = retained_size_content_height(
        text.as_ref(),
        size,
        line_height,
        width,
        available_height,
        || measured_height(window, text.clone(), prose_font, size, line_height, width),
    );

    TypeLayout {
        size,
        line_height,
        width,
        content_height,
        scrolls: content_height > available_height,
    }
}

fn retained_size_content_height(
    text: &str,
    size: f32,
    line_height: f32,
    width: f32,
    available_height: f32,
    measure: impl FnOnce() -> Option<f32>,
) -> (f32, bool) {
    let estimated = estimated_height(text, size, line_height, width);
    if estimated > available_height {
        return (estimated, false);
    }

    (measure().unwrap_or(estimated), true)
}

fn type_size_ceiling(
    text: &str,
    reading_width: f32,
    available_width: f32,
    available_height: f32,
    maximum_size: Option<f32>,
) -> f32 {
    let preferred = preferred_type_size(available_width, available_height);
    let soft_lines = estimated_soft_lines(text, preferred, reading_width);
    let short_copy_boost = if soft_lines <= 2.0 {
        10.0
    } else if soft_lines <= 4.0 {
        6.0
    } else if soft_lines <= 7.0 {
        2.0
    } else {
        0.0
    };
    let policy_ceiling = (preferred + short_copy_boost).min(MAX_TYPE_SIZE);
    quantize_size(
        maximum_size
            .unwrap_or(policy_ceiling)
            .min(policy_ceiling)
            .clamp(MIN_TYPE_SIZE, MAX_TYPE_SIZE),
    )
}

fn preferred_type_size(available_width: f32, available_height: f32) -> f32 {
    quantize_size(
        (available_width / 26.0)
            .min(available_height / 15.0)
            .clamp(MIN_PREFERRED_TYPE_SIZE, MAX_PREFERRED_TYPE_SIZE),
    )
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
    estimated_soft_lines(text, size, width) * size * line_height
}

fn estimated_soft_lines(text: &str, size: f32, width: f32) -> f32 {
    let average_glyph_width = size * 0.52;
    let characters_per_line = (width / average_glyph_width).max(1.0);
    text.lines()
        .map(|line| {
            (line.chars().count() as f32 / characters_per_line)
                .ceil()
                .max(1.0)
        })
        .sum::<f32>()
        .max(1.0)
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

pub(crate) fn line_height_for(size: f32) -> f32 {
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
        assert_eq!(quantize_size(53.9), 52.0);
        assert_eq!(quantize_size(24.0), 24.0);
    }

    #[test]
    fn long_copy_has_more_leading() {
        assert!(line_height_for(28.0) > line_height_for(72.0));
    }

    #[test]
    fn banded_search_preserves_linear_fit_at_leading_boundaries() {
        for maximum_size in (24..=54).step_by(2).map(|size| size as f32) {
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
        assert_eq!(overflowing_measurements, 4);

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
            614.0 * MAX_CONTENT_OCCUPANCY,
        ));
        assert!(!should_probe_minimum(
            "A short response.",
            1_020.0,
            614.0 * MAX_CONTENT_OCCUPANCY,
        ));
    }

    #[test]
    fn retained_overflow_uses_the_estimate_without_an_extra_shape() {
        let text = "A response that already extends past the viewport. ".repeat(200);
        let mut measurements = 0;
        let (height, measured) =
            retained_size_content_height(&text, 30.0, line_height_for(30.0), 820.0, 420.0, || {
                measurements += 1;
                Some(1.0)
            });

        assert!(height > 420.0);
        assert!(!measured);
        assert_eq!(measurements, 0);

        let (_, measured) = retained_size_content_height(
            "Short response.",
            30.0,
            line_height_for(30.0),
            820.0,
            420.0,
            || {
                measurements += 1;
                Some(42.0)
            },
        );
        assert!(measured);
        assert_eq!(measurements, 1);
    }

    #[test]
    fn preferred_scale_tracks_the_viewport_without_becoming_display_type() {
        assert_eq!(preferred_type_size(520.0, 360.0), 30.0);
        assert_eq!(preferred_type_size(1_020.0, 614.0), 38.0);
        assert_eq!(preferred_type_size(1_600.0, 1_000.0), 42.0);
    }

    #[test]
    fn short_copy_grows_modestly_while_paragraphs_stay_near_preferred() {
        let preferred = preferred_type_size(1_020.0, 614.0);
        let short = type_size_ceiling("Yes.", 820.0, 1_020.0, 614.0, None);
        let paragraph = type_size_ceiling(
            &"A normal paragraph should retain a comfortable reading scale. ".repeat(8),
            820.0,
            1_020.0,
            614.0,
            None,
        );

        assert_eq!(short, preferred + 10.0);
        assert!(paragraph >= preferred);
        assert!(paragraph <= preferred + 2.0);
    }

    #[test]
    fn long_copy_reaches_the_readability_floor_then_scrolls() {
        let fitted = find_fitted_size(MAX_TYPE_SIZE, 400.0 * MAX_CONTENT_OCCUPANCY, |size| {
            900.0 * size / MIN_TYPE_SIZE
        });

        assert_eq!(fitted.size, MIN_TYPE_SIZE);
        assert!(fitted.content_height > 400.0);
        assert!(!fitted.fits);
    }
}
