//! Drawing the transcript, draft, pickers, and help into a frame.

use super::App;
#[allow(unused_imports)]
use crate::prelude::*;

impl App {
    pub fn render(&mut self, frame: &mut Frame<'_>) {
        self.render_with_phases(frame, true, true);
    }

    pub fn render_with_cursor(&mut self, frame: &mut Frame<'_>, cursor_phase: bool) {
        self.render_with_phases(frame, cursor_phase, cursor_phase);
    }

    pub fn render_with_animation(&mut self, frame: &mut Frame<'_>, activity_phase: bool) {
        self.render_with_phases(frame, true, activity_phase);
    }

    pub(crate) fn render_with_phases(
        &mut self,
        frame: &mut Frame<'_>,
        cursor_phase: bool,
        activity_phase: bool,
    ) {
        let palette = self.theme.palette();
        let area = frame.area();
        self.media_slots.clear();
        self.last_browse_ranges.clear();
        frame.render_widget(
            Block::new().style(Style::new().bg(palette.background)),
            area,
        );
        if area.width < 28 || area.height < 8 {
            frame.render_widget(
                Paragraph::new("GSV needs a little more room")
                    .alignment(Alignment::Center)
                    .style(Style::new().fg(palette.foreground).bg(palette.background)),
                area,
            );
            return;
        }

        let vertical_margin = if area.height > 18 { 2 } else { 1 };
        let canvas = area.inner(Margin::new(0, vertical_margin));
        self.render_transcript(frame, canvas, cursor_phase, activity_phase);
        if self.help_visible {
            self.media_slots.clear();
            self.render_help(frame, area);
        }
    }

    pub(crate) fn render_transcript(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        cursor_phase: bool,
        activity_phase: bool,
    ) {
        let palette = self.theme.palette();
        let (turn_start, turn_end) = if self.moments.is_empty() {
            (0, 0)
        } else {
            let start = self.turn_start(self.selected);
            (start, self.turn_end(start))
        };
        let turn_artifacts = self
            .moments
            .get(turn_start..=turn_end)
            .into_iter()
            .flatten()
            .flat_map(|moment| moment.artifacts.iter())
            .cloned()
            .collect::<Vec<_>>();
        let image_artifacts = turn_artifacts
            .iter()
            .enumerate()
            .filter(|(_, artifact)| artifact.kind == MediaKind::Image)
            .map(|(artifact_index, artifact)| (artifact_index, artifact.clone()))
            .collect::<Vec<_>>();
        let focused_image = self.media_focus.and_then(|media_focus| {
            image_artifacts
                .iter()
                .position(|(artifact_index, _)| *artifact_index == media_focus)
        });
        let has_inline_images = self.inline_images && !image_artifacts.is_empty();

        if self.media_expanded && has_inline_images && focused_image.is_some() {
            self.last_max_scroll = 0;
            let focus = focused_image.unwrap_or_default();
            let footer_height = u16::from(image_artifacts.len() > 1);
            let media_area = Rect::new(
                area.x,
                area.y,
                area.width,
                area.height.saturating_sub(footer_height),
            );
            self.push_media_slots(
                frame,
                media_area,
                std::slice::from_ref(&image_artifacts[focus].1),
                None,
            );
            if footer_height > 0 {
                frame.render_widget(
                    Paragraph::new(format!(
                        "\u{2039}  {} / {}  \u{203a}",
                        focus + 1,
                        image_artifacts.len()
                    ))
                    .style(Style::new().fg(self.theme.palette().quiet))
                    .alignment(Alignment::Center),
                    Rect::new(area.x, area.bottom().saturating_sub(1), area.width, 1),
                );
            }
            return;
        }

        let show_prompt =
            self.draft_visible || self.follow_latest || self.completion_picker_visible();
        let mut prompt = show_prompt.then(|| {
            let (draft, cursor, style_ranges) = self.visible_draft(palette);
            let mut prompt = prompted_text_lines(
                self.input_prompt(self.active_environment(), self.execution_mode),
                &draft,
                area.width,
                Style::new().fg(palette.foreground),
                &style_ranges,
                Some(cursor),
            );
            if draft.is_empty() {
                if let Some(line) = prompt.lines.first_mut() {
                    line.spans.push(Span::styled(
                        match self.execution_mode {
                            ExecutionMode::Ship => "type a request",
                            ExecutionMode::Shell => "literal shell command",
                        },
                        Style::new().fg(palette.quiet),
                    ));
                }
            }
            prompt
        });
        let prompt_height = prompt
            .as_ref()
            .map(|prompt| {
                u16::try_from(prompt.lines.len())
                    .unwrap_or(u16::MAX)
                    .min(area.height)
                    .max(1)
            })
            .unwrap_or(0);
        let viewport_height = area.height.saturating_sub(prompt_height);
        let image_height = if self.inline_images && viewport_height > 0 {
            (area.height.saturating_mul(2) / 5)
                .clamp(5, 12)
                .min(viewport_height)
        } else {
            0
        };
        let mut blocks = Vec::new();
        let mut document_height = 0_u16;
        let mut moment_starts = vec![0_u16; self.moments.len()];
        let mut turn_artifact_index = 0_usize;
        let mut focused_media_range = None;
        let mut browse_ranges = Vec::new();
        let mut rendered_action_counts = Vec::new();
        let mut rendered_approval = false;

        if self.history_loading {
            push_transcript_text(
                &mut blocks,
                &mut document_height,
                vec![activity_line(
                    Some("loading earlier history"),
                    palette,
                    activity_phase,
                )],
                area.width,
            );
        }

        for (index, moment) in self.moments.iter().enumerate() {
            if moment.role == Role::Human && document_height > 0 {
                push_transcript_text(
                    &mut blocks,
                    &mut document_height,
                    vec![Line::default()],
                    area.width,
                );
            }
            if index == self.turn_start(index) {
                turn_artifact_index = 0;
            }
            moment_starts[index] = document_height;
            if moment.role != Role::Human {
                if let Some(run_id) = moment.run_id.as_deref() {
                    self.push_action_run_segment(
                        &mut rendered_action_counts,
                        &mut blocks,
                        &mut document_height,
                        ActionSegmentRequest {
                            run_id,
                            width: area.width,
                            activity_phase,
                            cutoff: moment.timestamp,
                            after_moment_id: None,
                            flush: false,
                        },
                    );
                }
            }
            let body = moment.text.as_str();
            let empty_streaming = body.is_empty() && moment.state == MomentState::Streaming;
            let action_is_active = moment
                .run_id
                .as_deref()
                .is_some_and(|run_id| self.run_has_active_action(run_id));
            let body_color = if moment.state == MomentState::Error {
                palette.error
            } else {
                moment.role.color(palette)
            };
            let in_selected_turn = (turn_start..=turn_end).contains(&index);
            let artifact_indices = (turn_artifact_index
                ..turn_artifact_index.saturating_add(moment.artifacts.len()))
                .collect::<Vec<_>>();
            turn_artifact_index = turn_artifact_index.saturating_add(moment.artifacts.len());
            let artifact_focus = artifact_indices
                .iter()
                .map(|artifact_index| in_selected_turn && self.media_focus == Some(*artifact_index))
                .collect::<Vec<_>>();
            let inline_artifacts = if moment.role == Role::Human {
                inline_artifact_occurrences(body, &moment.artifacts)
            } else {
                vec![None; moment.artifacts.len()]
            };
            let inline_styles = inline_artifacts
                .iter()
                .zip(&artifact_focus)
                .filter_map(|(occurrence, focused)| {
                    occurrence.map(|(start, end)| TextStyleRange {
                        start,
                        end,
                        style: Style::new()
                            .fg(palette.path)
                            .add_modifier(Modifier::UNDERLINED)
                            .add_modifier(if *focused {
                                Modifier::BOLD
                            } else {
                                Modifier::empty()
                            }),
                    })
                })
                .collect::<Vec<_>>();
            let mut has_content = !body.is_empty() || (empty_streaming && !action_is_active);
            let body_top = document_height;
            if has_content {
                let mut body_lines = if empty_streaming {
                    vec![activity_line(
                        self.activity.as_deref(),
                        palette,
                        activity_phase,
                    )]
                } else {
                    match moment.role {
                        Role::Human => {
                            let environment = moment
                                .environment
                                .as_ref()
                                .unwrap_or_else(|| self.default_environment());
                            prompted_text_lines(
                                self.input_prompt(environment, moment.execution),
                                body,
                                area.width,
                                Style::new().fg(body_color),
                                &inline_styles,
                                None,
                            )
                            .lines
                        }
                        Role::Intelligence
                            if moment.execution == ExecutionMode::Ship && !self.raw_markdown =>
                        {
                            render_markdown(body, palette)
                        }
                        Role::Intelligence if moment.execution == ExecutionMode::Shell => {
                            render_plain(
                                body.strip_suffix('\n').unwrap_or(body),
                                Style::new().fg(body_color),
                            )
                        }
                        Role::Intelligence | Role::System => {
                            render_plain(body, Style::new().fg(body_color))
                        }
                    }
                };
                if !empty_streaming && moment.state == MomentState::Streaming {
                    append_activity_cursor(&mut body_lines, palette, activity_phase);
                }
                push_transcript_text(&mut blocks, &mut document_height, body_lines, area.width);
            }
            if inline_artifacts
                .iter()
                .zip(&artifact_focus)
                .any(|(occurrence, focused)| occurrence.is_some() && *focused)
            {
                focused_media_range = Some((body_top, document_height));
            }
            if document_height > moment_starts[index] {
                browse_ranges.push(BrowseRange {
                    top: moment_starts[index],
                    bottom: document_height,
                    target: BrowseTarget::Moment(index),
                });
            }

            for (((artifact, inline), focused), media_focus) in moment
                .artifacts
                .iter()
                .zip(inline_artifacts)
                .zip(artifact_focus)
                .zip(artifact_indices)
            {
                if inline.is_some() && artifact.kind == MediaKind::Document {
                    continue;
                }
                if has_content {
                    push_transcript_text(
                        &mut blocks,
                        &mut document_height,
                        vec![Line::default()],
                        area.width,
                    );
                }
                let top = document_height;
                if artifact.kind == MediaKind::Image && image_height > 0 {
                    blocks.push(TranscriptBlock::Image {
                        top,
                        height: image_height,
                        artifact: artifact.clone(),
                        focused,
                    });
                    document_height = document_height.saturating_add(image_height);
                } else {
                    push_transcript_text(
                        &mut blocks,
                        &mut document_height,
                        render_artifacts(&[(artifact, focused)], palette),
                        area.width,
                    );
                }
                if focused {
                    focused_media_range = Some((top, document_height));
                }
                browse_ranges.push(BrowseRange {
                    top,
                    bottom: document_height,
                    target: BrowseTarget::Media {
                        moment_index: index,
                        media_focus,
                    },
                });
                has_content = true;
            }
            if let Some(run_id) = moment.run_id.as_deref() {
                self.push_action_run_segment(
                    &mut rendered_action_counts,
                    &mut blocks,
                    &mut document_height,
                    ActionSegmentRequest {
                        run_id,
                        width: area.width,
                        activity_phase,
                        cutoff: None,
                        after_moment_id: Some(&moment.id),
                        flush: false,
                    },
                );
            }
            if let Some(run_id) = moment.run_id.as_deref() {
                let run_continues = self.moments.get(index + 1).is_some_and(|next| {
                    next.role != Role::Human && next.run_id.as_deref() == Some(run_id)
                });
                if !run_continues {
                    self.push_action_run_segment(
                        &mut rendered_action_counts,
                        &mut blocks,
                        &mut document_height,
                        ActionSegmentRequest {
                            run_id,
                            width: area.width,
                            activity_phase,
                            cutoff: None,
                            after_moment_id: None,
                            flush: true,
                        },
                    );
                    if !rendered_approval && self.approval_run_id.as_deref() == Some(run_id) {
                        if let Some(approval) = &self.approval {
                            push_transcript_text(
                                &mut blocks,
                                &mut document_height,
                                render_approval_lines(approval, palette),
                                area.width,
                            );
                            rendered_approval = true;
                        }
                    }
                }
            }
        }
        if !rendered_approval {
            if let Some(approval) = &self.approval {
                push_transcript_text(
                    &mut blocks,
                    &mut document_height,
                    render_approval_lines(approval, palette),
                    area.width,
                );
            }
        }
        self.last_browse_ranges = browse_ranges;

        self.last_viewport_height = viewport_height.max(1);
        self.last_max_scroll = document_height.saturating_sub(viewport_height);
        let anchor = self.scroll_anchor.take();
        let scroll_direction = self.pending_scroll_direction.take();
        if self.follow_latest {
            self.document_scroll = self.last_max_scroll;
        } else {
            self.document_scroll = self.document_scroll.min(self.last_max_scroll);
            match anchor {
                Some(ScrollAnchor::Moment(index)) => {
                    self.document_scroll = moment_starts
                        .get(index)
                        .copied()
                        .unwrap_or_default()
                        .min(self.last_max_scroll);
                }
                Some(ScrollAnchor::Media) => {
                    if let Some((top, bottom)) = focused_media_range {
                        let viewport_bottom = self.document_scroll.saturating_add(viewport_height);
                        if top < self.document_scroll {
                            self.document_scroll = top;
                        } else if bottom > viewport_bottom {
                            self.document_scroll = bottom
                                .saturating_sub(viewport_height)
                                .min(self.last_max_scroll);
                        }
                    }
                }
                None => {
                    if let Some(direction) = scroll_direction {
                        self.document_scroll = snap_partial_media_scroll(
                            self.document_scroll,
                            direction,
                            self.last_viewport_height,
                            self.last_max_scroll,
                            &self.last_browse_ranges,
                        );
                    }
                }
            }
        }
        if let Some(direction) = scroll_direction {
            self.sync_browse_focus(direction);
        } else if !self.draft_visible && self.follow_latest {
            self.sync_browse_focus(ScrollDirection::Newer);
        }

        if viewport_height > 0 && document_height > 0 {
            let viewport_top = self.document_scroll;
            let viewport_bottom = viewport_top.saturating_add(viewport_height);
            let bottom_alignment = viewport_height.saturating_sub(document_height);
            for block in blocks {
                let block_top = block.top();
                let block_bottom = block_top.saturating_add(block.height());
                let visible_top = block_top.max(viewport_top);
                let visible_bottom = block_bottom.min(viewport_bottom);
                if visible_top >= visible_bottom {
                    continue;
                }
                let block_area = Rect::new(
                    area.x,
                    area.y + bottom_alignment + visible_top.saturating_sub(viewport_top),
                    area.width,
                    visible_bottom.saturating_sub(visible_top),
                );
                match block {
                    TranscriptBlock::Text { lines, .. } => {
                        frame.render_widget(
                            Paragraph::new(Text::from(lines))
                                .wrap(Wrap { trim: false })
                                .scroll((visible_top.saturating_sub(block_top), 0)),
                            block_area,
                        );
                    }
                    TranscriptBlock::Image {
                        artifact, focused, ..
                    } if visible_top == block_top && visible_bottom == block_bottom => {
                        self.push_media_slots(
                            frame,
                            block_area,
                            std::slice::from_ref(&artifact),
                            focused.then_some(0),
                        );
                    }
                    TranscriptBlock::Image {
                        artifact, focused, ..
                    } => {
                        let style = Style::new()
                            .fg(if focused {
                                palette.accent
                            } else {
                                palette.quiet
                            })
                            .add_modifier(if focused {
                                Modifier::BOLD
                            } else {
                                Modifier::empty()
                            });
                        frame.render_widget(
                            Paragraph::new(format!(
                                "▧  {}",
                                sanitize_label(artifact.display_name(), "image", 96)
                            ))
                            .style(style)
                            .alignment(Alignment::Center),
                            block_area,
                        );
                    }
                }
            }
        }
        if let Some(prompt) = prompt.take() {
            let cursor_row = prompt.cursor_row;
            let cursor_col = prompt.cursor_col;
            let prompt_area = Rect::new(
                area.x,
                area.bottom().saturating_sub(prompt_height),
                area.width,
                prompt_height,
            );
            let scroll = cursor_row.saturating_sub(prompt_height.saturating_sub(1));
            frame.render_widget(
                Paragraph::new(prompt.lines).scroll((scroll, 0)),
                prompt_area,
            );
            if self.cursor_visible() && cursor_phase {
                let cursor_y = prompt_area.y + cursor_row.saturating_sub(scroll);
                let cursor_x = prompt_area.x + cursor_col.min(prompt_area.width.saturating_sub(1));
                if cursor_y < prompt_area.bottom() {
                    frame.set_cursor_position(Position::new(cursor_x, cursor_y));
                }
            }
            self.render_completion_picker(frame, area, prompt_area, activity_phase);
        }
    }

    pub(crate) fn visible_draft(&self, palette: Palette) -> (String, usize, Vec<TextStyleRange>) {
        if let Some(picker) = &self.reference_picker {
            let value = if picker.query.is_empty() {
                "open ".to_string()
            } else {
                format!("open {}", picker.query)
            };
            let end = value.len();
            return (
                value,
                end,
                vec![TextStyleRange {
                    start: 0,
                    end: 4,
                    style: Style::new().fg(palette.accent).add_modifier(Modifier::BOLD),
                }],
            );
        }

        if let Some(search) = &self.transcript_search {
            let value = format!("/{}", search.query);
            let end = value.len();
            return (
                value,
                end,
                vec![TextStyleRange {
                    start: 0,
                    end: 1,
                    style: Style::new().fg(palette.accent).add_modifier(Modifier::BOLD),
                }],
            );
        }

        if let Some(search) = &self.command_search {
            let value = self
                .command_search_preview()
                .map(|entry| entry.text.clone())
                .unwrap_or_else(|| search.original.text.clone());
            let end = value.len();
            return (value, end, Vec::new());
        }

        if self.environment_picker {
            let value = format!("@{}", self.environment_query);
            let end = value.len();
            return (
                value,
                end,
                vec![TextStyleRange {
                    start: 0,
                    end,
                    style: Style::new().fg(palette.accent).add_modifier(Modifier::BOLD),
                }],
            );
        }

        let mut value = self.draft.clone();
        let mut ranges = self
            .draft_references
            .iter()
            .map(|reference| TextStyleRange {
                start: reference.start,
                end: reference.end,
                style: Style::new()
                    .fg(palette.path)
                    .add_modifier(Modifier::UNDERLINED),
            })
            .collect::<Vec<_>>();
        let mut cursor = self.draft_cursor;
        if let Some(picker) = &self.file_picker {
            let insertion = picker.insertion.min(value.len());
            let completion = format!("@{}", picker.query);
            let completion_len = completion.len();
            for range in &mut ranges {
                if range.start >= insertion {
                    range.start = range.start.saturating_add(completion_len);
                    range.end = range.end.saturating_add(completion_len);
                }
            }
            value.insert_str(insertion, &completion);
            ranges.push(TextStyleRange {
                start: insertion,
                end: insertion.saturating_add(completion_len),
                style: Style::new()
                    .fg(palette.path)
                    .add_modifier(Modifier::UNDERLINED),
            });
            cursor = insertion.saturating_add(completion_len);
        }
        ranges.sort_by_key(|range| range.start);
        (value, cursor, ranges)
    }

    pub(crate) fn render_completion_picker(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        prompt_area: Rect,
        activity_phase: bool,
    ) {
        const MAX_ROWS: usize = 7;

        if !self.completion_picker_visible() || prompt_area.y <= area.y {
            return;
        }
        let palette = self.theme.palette();
        let mut lines = Vec::new();
        if let Some(picker) = &self.reference_picker {
            let matches = self.matching_reference_indices();
            let selected = picker.choice.min(matches.len().saturating_sub(1));
            for (choice, index) in matches
                .iter()
                .copied()
                .enumerate()
                .skip(selected.saturating_sub(MAX_ROWS.saturating_sub(1)))
                .take(MAX_ROWS)
            {
                let reference = &picker.references[index];
                let is_selected = choice == selected;
                let marker = if is_selected { "› " } else { "  " };
                let label = sanitize_label(reference.label(), "reference", 72);
                let destination = match reference {
                    OpenReference::Url { url, .. } if url != reference.label() => {
                        Some(sanitize_label(url, "url", 96))
                    }
                    OpenReference::Path { target, path, .. } => Some(format!(
                        "{}:{}",
                        prompt_token(target, "target"),
                        sanitize_label(path, "path", 96)
                    )),
                    OpenReference::Url { .. } => None,
                };
                let mut spans = vec![Span::styled(
                    format!("{marker}{label}"),
                    Style::new()
                        .fg(if is_selected {
                            palette.accent
                        } else {
                            palette.foreground
                        })
                        .add_modifier(if is_selected {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                )];
                if let Some(destination) = destination {
                    spans.push(Span::styled(
                        format!("  {destination}"),
                        Style::new().fg(palette.quiet),
                    ));
                }
                lines.push(Line::from(spans));
            }
            if matches.is_empty() {
                lines.push(Line::from(Span::styled(
                    "  no matching reference",
                    Style::new().fg(palette.quiet),
                )));
            }
        } else if let Some(search) = &self.command_search {
            let matches = self.matching_command_indices();
            let selected = search.choice.min(matches.len().saturating_sub(1));
            lines.push(Line::from(vec![
                Span::styled(
                    "  reverse history",
                    Style::new().fg(palette.accent).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    if search.query.is_empty() {
                        String::new()
                    } else {
                        format!(" · {}", sanitize_label(&search.query, "", 80))
                    },
                    Style::new().fg(palette.quiet),
                ),
            ]));
            let start = selected.saturating_sub(MAX_ROWS.saturating_sub(2));
            for (choice, index) in matches
                .iter()
                .copied()
                .enumerate()
                .skip(start)
                .take(MAX_ROWS.saturating_sub(1))
            {
                let is_selected = choice == selected;
                let marker = if is_selected { "› " } else { "  " };
                let command = sanitize_label(&self.command_history[index].text, "command", 120);
                lines.push(Line::from(Span::styled(
                    format!("{marker}{command}"),
                    Style::new()
                        .fg(if is_selected {
                            palette.foreground
                        } else {
                            palette.quiet
                        })
                        .add_modifier(if is_selected {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                )));
            }
            if matches.is_empty() {
                lines.push(Line::from(Span::styled(
                    "  no matching command",
                    Style::new().fg(palette.quiet),
                )));
            }
        } else if let Some(search) = &self.transcript_search {
            let matches = self.matching_transcript_indices(&search.query);
            let selected = search.choice.min(matches.len().saturating_sub(1));
            lines.push(Line::from(vec![
                Span::styled(
                    "  transcript",
                    Style::new().fg(palette.accent).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(" · {} matches", matches.len()),
                    Style::new().fg(palette.quiet),
                ),
            ]));
            let start = selected.saturating_sub(MAX_ROWS.saturating_sub(2));
            for (choice, index) in matches
                .iter()
                .copied()
                .enumerate()
                .skip(start)
                .take(MAX_ROWS.saturating_sub(1))
            {
                let is_selected = choice == selected;
                let moment = &self.moments[index];
                let marker = if is_selected { "› " } else { "  " };
                let role = match moment.role {
                    Role::Human => "$",
                    Role::Intelligence => "›",
                    Role::System => "!",
                };
                let preview = sanitize_label(&moment.text, "media", 112);
                lines.push(Line::from(Span::styled(
                    format!("{marker}{role} {preview}"),
                    Style::new()
                        .fg(if is_selected {
                            palette.foreground
                        } else {
                            palette.quiet
                        })
                        .add_modifier(if is_selected {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                )));
            }
            if matches.is_empty() {
                lines.push(Line::from(Span::styled(
                    "  no matching message",
                    Style::new().fg(palette.quiet),
                )));
            }
        } else if self.environment_picker {
            let matches = self.matching_environment_indices();
            let selected = self.environment_choice.min(matches.len().saturating_sub(1));
            let start = selected.saturating_sub(MAX_ROWS.saturating_sub(1));
            for (choice, index) in matches
                .iter()
                .copied()
                .enumerate()
                .skip(start)
                .take(MAX_ROWS)
            {
                let environment = &self.environments[index];
                let is_selected = choice == selected;
                let marker = if is_selected { "› " } else { "  " };
                let target = prompt_token(&environment.target, "target");
                let label = sanitize_label(&environment.label, &target, 80);
                let mut spans = vec![Span::styled(
                    format!("{marker}{target}"),
                    Style::new()
                        .fg(if is_selected {
                            palette.accent
                        } else {
                            palette.foreground
                        })
                        .add_modifier(if is_selected {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                )];
                if label != target {
                    spans.push(Span::styled(
                        format!("  {label}"),
                        Style::new().fg(palette.quiet),
                    ));
                }
                lines.push(Line::from(spans));
            }
            if lines.is_empty() {
                lines.push(Line::from(Span::styled(
                    "  no matching target",
                    Style::new().fg(palette.quiet),
                )));
            }
        } else if let Some(picker) = &self.file_picker {
            if picker.loading {
                lines.push(activity_line(Some("loading"), palette, activity_phase));
            } else if let Some(error) = &picker.error {
                lines.push(Line::from(Span::styled(
                    format!("  {error}"),
                    Style::new().fg(palette.error),
                )));
            } else {
                let matches = self.matching_file_entries();
                let selected = picker.choice.min(matches.len().saturating_sub(1));
                let start = selected.saturating_sub(MAX_ROWS.saturating_sub(1));
                for (choice, entry) in matches.iter().enumerate().skip(start).take(MAX_ROWS) {
                    let is_selected = choice == selected;
                    let marker = if is_selected { "› " } else { "  " };
                    let name = sanitize_label(&entry.name, "file", 120);
                    let suffix = if entry.is_directory { "/" } else { "" };
                    lines.push(Line::from(Span::styled(
                        format!("{marker}{name}{suffix}"),
                        Style::new()
                            .fg(if is_selected || entry.is_directory {
                                palette.path
                            } else {
                                palette.foreground
                            })
                            .add_modifier(if is_selected {
                                Modifier::BOLD
                            } else {
                                Modifier::empty()
                            }),
                    )));
                }
                if lines.is_empty() {
                    lines.push(Line::from(Span::styled(
                        "  no matching file",
                        Style::new().fg(palette.quiet),
                    )));
                }
            }
        }

        let available_height = prompt_area.y.saturating_sub(area.y);
        let height = u16::try_from(lines.len())
            .unwrap_or(u16::MAX)
            .min(available_height)
            .max(1);
        let width = area.width.clamp(1, 72);
        let picker_area = Rect::new(
            prompt_area.x,
            prompt_area.y.saturating_sub(height),
            width,
            height,
        );
        frame.render_widget(Clear, picker_area);
        frame.render_widget(
            Paragraph::new(lines).style(Style::new().fg(palette.foreground).bg(palette.background)),
            picker_area,
        );
        self.media_slots
            .retain(|slot| !rectangles_intersect(slot.area, picker_area));
    }

    pub(crate) fn push_media_slots(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        artifacts: &[Artifact],
        focused: Option<usize>,
    ) {
        if artifacts.is_empty() || area.width == 0 || area.height == 0 {
            return;
        }
        let palette = self.theme.palette();
        let count = u16::try_from(artifacts.len()).unwrap_or(u16::MAX).max(1);
        let gap = 2_u16;
        let total_gap = gap.saturating_mul(count.saturating_sub(1));
        let slot_width = area.width.saturating_sub(total_gap) / count;
        for (index, artifact) in artifacts.iter().enumerate() {
            let index = u16::try_from(index).unwrap_or(u16::MAX);
            let x = area.x + index.saturating_mul(slot_width.saturating_add(gap));
            let width = if index + 1 == count {
                area.right().saturating_sub(x)
            } else {
                slot_width
            };
            let slot_area = Rect::new(x, area.y, width, area.height);
            let content_area = if width > 2 && area.height > 2 {
                slot_area.inner(Margin::new(1, 1))
            } else {
                slot_area
            };
            if focused == Some(usize::from(index)) {
                frame.render_widget(
                    Block::new()
                        .borders(Borders::LEFT)
                        .border_style(Style::new().fg(palette.accent)),
                    slot_area,
                );
            }
            frame.render_widget(
                Paragraph::new(sanitize_label(artifact.display_name(), "image", 96))
                    .style(Style::new().fg(palette.quiet))
                    .alignment(Alignment::Center),
                content_area,
            );
            self.media_slots.push(MediaSlot {
                key: artifact.cache_key(),
                area: content_area,
                artifact: artifact.clone(),
            });
        }
    }

    pub(crate) fn render_help(&self, frame: &mut Frame<'_>, area: Rect) {
        let palette = self.theme.palette();
        let width = area.width.saturating_sub(8).min(68);
        let height = area.height.min(26);
        let popup = centered_rect(area, width, height);
        frame.render_widget(Clear, popup);
        let mut lines = vec![
            Line::from(Span::styled(
                "keys",
                Style::new()
                    .fg(palette.foreground)
                    .add_modifier(Modifier::BOLD),
            )),
            Line::default(),
            help_line("type  ·  enter", "write  ·  send", palette),
            help_line("shift+enter", "new line", palette),
            help_line("tab", "Ship / literal shell", palette),
            help_line("@  ·  ctrl+o", "target/file completion  ·  files", palette),
            help_line("escape", "browse without losing the draft", palette),
            help_line("up/down  ·  ctrl+p/n", "command history", palette),
            help_line("ctrl+r", "fuzzy command search", palette),
            help_line("/  ·  n/N", "search transcript  ·  next/previous", palette),
            help_line(
                "browse: up/down",
                "step  ·  pgup/pgdn  ·  ctrl+u/d page",
                palette,
            ),
            help_line(
                "left/right  ·  enter/o",
                "media  ·  open  ·  references",
                palette,
            ),
            help_line("browse: t/m/v", "actions  ·  Markdown  ·  Vim", palette),
            help_line("ctrl+c  ·  ctrl+q", "stop Ship  ·  leave", palette),
        ];
        if self.vim_enabled {
            lines.extend([
                Line::default(),
                help_line("Vim: i/a  ·  escape", "compose  ·  browse", palette),
                help_line("Vim: j/k  ·  g/G", "browse  ·  ends", palette),
                help_line("Vim: h/l  ·  enter/o", "media  ·  open/references", palette),
            ]);
        }
        lines.extend([
            Line::default(),
            Line::from(Span::styled(
                "Press ? or escape to return",
                Style::new().fg(palette.muted),
            )),
        ]);
        let help = Text::from(lines);
        frame.render_widget(
            Paragraph::new(help)
                .block(
                    Block::new()
                        .borders(Borders::ALL)
                        .border_type(BorderType::Rounded)
                        .border_style(Style::new().fg(palette.quiet))
                        .style(Style::new().bg(palette.background))
                        .padding(Padding::new(3, 3, 1, 1)),
                )
                .wrap(Wrap { trim: false }),
            popup,
        );
    }
}
