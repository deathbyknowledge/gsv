use gpui::{font, px, FontWeight, SharedString, TextRun, Window};

use crate::theme;

const MAX_TYPE_SIZE: f32 = 72.0;
const MIN_TYPE_SIZE: f32 = 28.0;
const TYPE_STEP: f32 = 2.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TypeLayout {
    pub size: f32,
    pub line_height: f32,
    pub width: f32,
    pub content_height: f32,
    pub scrolls: bool,
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
    let mut size = quantize_size(maximum_size);
    let text: SharedString = if text.is_empty() {
        " ".into()
    } else {
        text.to_string().into()
    };
    let mut prose_font = font(theme::PROSE_FONT);
    prose_font.weight = weight;

    loop {
        let line_height = line_height_for(size);
        let content_height = measured_height(
            window,
            text.clone(),
            prose_font.clone(),
            size,
            line_height,
            width,
        )
        .unwrap_or_else(|| estimated_height(text.as_ref(), size, line_height, width));
        let fits = content_height <= available_height;
        if fits || size <= MIN_TYPE_SIZE {
            return TypeLayout {
                size,
                line_height,
                width,
                content_height,
                scrolls: !fits,
            };
        }
        size = (size - TYPE_STEP).max(MIN_TYPE_SIZE);
    }
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
}
