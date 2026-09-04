//! Text measurement and sanitization helpers.

#[allow(unused_imports)]
use crate::prelude::*;

pub(crate) fn previous_grapheme_boundary(value: &str, cursor: usize) -> Option<usize> {
    value[..cursor]
        .grapheme_indices(true)
        .next_back()
        .map(|(index, _)| index)
}

pub(crate) fn prompt_token(value: &str, fallback: &str) -> String {
    let token = value
        .trim()
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        .take(32)
        .collect::<String>();
    if token.is_empty() {
        fallback.to_string()
    } else {
        token
    }
}

pub(crate) fn sanitize_draft_input(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| match character {
            '\n' => vec!['\n'],
            '\t' => vec![' ', ' ', ' ', ' '],
            character if character.is_control() => Vec::new(),
            character => vec![character],
        })
        .collect()
}

pub(crate) fn sanitize_status(value: &str) -> String {
    sanitize_label(value, "WORKING", 80)
}

pub(crate) fn fuzzy_score(query: &str, candidate: &str) -> Option<i64> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Some(0);
    }
    let candidate = candidate.to_lowercase();
    let query_chars = query.chars().collect::<Vec<_>>();
    let candidate_chars = candidate.chars().collect::<Vec<_>>();
    let mut positions = Vec::with_capacity(query_chars.len());
    let mut cursor = 0_usize;
    for needle in query_chars {
        let offset = candidate_chars[cursor..]
            .iter()
            .position(|character| *character == needle)?;
        let position = cursor + offset;
        positions.push(position);
        cursor = position.saturating_add(1);
    }

    let mut score = 0_i64;
    for (index, position) in positions.iter().copied().enumerate() {
        if position == 0
            || candidate_chars
                .get(position.saturating_sub(1))
                .is_some_and(|character| {
                    character.is_whitespace() || matches!(character, '/' | '\\' | '_' | '-' | '.')
                })
        {
            score += 24;
        }
        if index > 0 && position == positions[index - 1].saturating_add(1) {
            score += 18;
        }
        score -= i64::try_from(position).unwrap_or(i64::MAX) / 4;
    }
    if candidate.starts_with(&query) {
        score += 120;
    } else if candidate.contains(&query) {
        score += 80;
    }
    score -= i64::try_from(candidate_chars.len().saturating_sub(positions.len()))
        .unwrap_or(i64::MAX)
        / 8;
    Some(score)
}

pub(crate) fn sanitize_label(value: &str, fallback: &str, max_chars: usize) -> String {
    let status = value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect::<String>();
    if status.trim().is_empty() {
        fallback.to_string()
    } else {
        status
    }
}

pub(crate) fn sanitize_multiline(value: &str, max_chars: usize) -> String {
    sanitize_draft_input(value)
        .chars()
        .take(max_chars)
        .collect()
}

pub(crate) fn next_grapheme_boundary(value: &str, cursor: usize) -> Option<usize> {
    value[cursor..]
        .grapheme_indices(true)
        .nth(1)
        .map(|(index, _)| cursor + index)
        .or_else(|| (cursor < value.len()).then_some(value.len()))
}

#[cfg(test)]
pub(crate) fn text_metrics(value: &str, cursor: usize, width: u16) -> (u16, u16, u16) {
    let width = width.max(1);
    let mut row = 0_u16;
    let mut col = 0_u16;
    let mut cursor_position = None;
    for (index, grapheme) in value.grapheme_indices(true) {
        if index == cursor {
            cursor_position = Some((row, col));
        }
        if grapheme == "\n" {
            row = row.saturating_add(1);
            col = 0;
            continue;
        }
        let grapheme_width = u16::try_from(UnicodeWidthStr::width(grapheme))
            .unwrap_or(1)
            .max(1);
        if col.saturating_add(grapheme_width) > width {
            row = row.saturating_add(1);
            col = 0;
        }
        col = col.saturating_add(grapheme_width);
        if col >= width {
            row = row.saturating_add(1);
            col = 0;
        }
    }
    let (cursor_row, cursor_col) = cursor_position.unwrap_or((row, col));
    (cursor_row, cursor_col, row.saturating_add(1))
}
