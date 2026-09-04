#[allow(unused_imports)]
use crate::prelude::*;
#[allow(unused_imports)]
use crate::*;

use ratatui::backend::TestBackend;
use ratatui::style::Modifier;
use ratatui::Terminal;

use crate::prelude::{
    fuzzy_score, media_is_partial, sanitize_status, text_metrics, Action, AgentActionSnapshot, App,
    Approval, Artifact, CapabilityEnvironment, ConnectionState, Effect, ExecutionMode, FileEntry,
    FileReference, MediaKind, MessageDeliverySnapshot, Moment, MomentState, Role, Theme,
};

fn image_artifact(index: usize) -> Artifact {
    Artifact {
        kind: MediaKind::Image,
        mime_type: "image/png".to_string(),
        filename: Some(format!("image-{index}.png")),
        size: Some(2048),
        duration_ms: None,
        transcription: None,
        source: Some(format!("gsv:/home/ship/image-{index}.png")),
        revision: Some(format!("sha256:{index}")),
    }
}

fn audio_artifact(index: usize) -> Artifact {
    Artifact {
        kind: MediaKind::Audio,
        mime_type: "audio/ogg".to_string(),
        filename: Some(format!("voice-{index}.ogg")),
        size: Some(2048),
        duration_ms: Some(1_000),
        transcription: None,
        source: Some(format!("gsv:/home/ship/voice-{index}.ogg")),
        revision: Some(format!("sha256:voice-{index}")),
    }
}

fn file_reference(filename: &str) -> FileReference {
    FileReference {
        target: "macbook".to_string(),
        path: format!("/Users/sam/Downloads/{filename}"),
        revision: format!("mtime:{filename}"),
        content_type: "text/markdown".to_string(),
        size: 512,
        filename: filename.to_string(),
    }
}

#[test]
fn typing_replaces_the_moment_and_escape_preserves_the_draft() {
    let mut app = App::demo();
    assert!(app.cursor_visible());
    app.dispatch(Action::Insert("open downloads".to_string()));
    assert!(app.draft_visible());
    app.dispatch(Action::Escape);
    assert!(!app.draft_visible());
    assert!(!app.cursor_visible());
    assert_eq!(app.draft(), "open downloads");
    app.dispatch(Action::Insert(" please".to_string()));
    assert_eq!(app.draft(), "open downloads please");
}

#[test]
fn toggling_vim_controls_preserves_browse_mode() {
    let mut app = App::new(ConnectionState::Ready);
    app.dispatch(Action::Escape);

    app.dispatch(Action::ToggleVim);
    assert!(app.vim_enabled());
    assert!(!app.draft_visible());

    app.dispatch(Action::ToggleVim);
    assert!(!app.vim_enabled());
    assert!(!app.draft_visible());
}

#[test]
fn submission_is_optimistic_and_restores_failed_text() {
    let mut app = App::new(ConnectionState::Ready);
    app.dispatch(Action::Insert("show downloads".to_string()));
    assert_eq!(
        app.dispatch(Action::Submit),
        vec![Effect::Submit {
            id: 1,
            text: "show downloads".to_string(),
            target: "gsv".to_string(),
            cwd: None,
            references: Vec::new(),
        }]
    );
    assert_eq!(app.moments().len(), 2);
    app.submission_failed(1, "Could not connect");
    assert_eq!(app.draft(), "show downloads");
    assert!(app.draft_visible());
}

#[test]
fn navigation_moves_between_complete_turns() {
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![
        Moment::complete("one", Role::Human, "one"),
        Moment::complete("two", Role::Intelligence, "two"),
        Moment::complete("three", Role::Human, "three"),
        Moment::complete("four", Role::Intelligence, "four"),
    ]);
    assert_eq!(app.selected(), 3);
    app.dispatch(Action::Escape);
    app.dispatch(Action::PreviousTurn);
    assert_eq!(app.selected(), 1);
    app.dispatch(Action::NextTurn);
    assert_eq!(app.selected(), 3);
}

#[test]
fn render_keeps_commands_in_one_continuous_document() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![
        Moment::complete("one", Role::Human, "older command"),
        Moment::complete("two", Role::Intelligence, "older secret"),
        Moment::complete("three", Role::Human, "visible command"),
        Moment::complete("four", Role::Intelligence, "visible answer"),
    ]);
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("visible answer"));
    assert!(rendered.contains("you@gsv $ visible command"));
    assert!(rendered.contains("older secret"));
    assert!(rendered.contains("you@gsv $ older command"));
    Ok(())
}

#[test]
fn one_run_can_commit_multiple_visible_messages_while_the_prompt_stays_active(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.dispatch(Action::Insert("work on it".to_string()));
    app.dispatch(Action::Submit);
    app.submission_accepted(1, "run:one".to_string(), false);
    app.commit_message(
        "message:one",
        Role::Intelligence,
        "First update.",
        Some("run:one".to_string()),
        Vec::new(),
        None,
    );
    app.commit_message(
        "message:two",
        Role::Intelligence,
        "Second update.",
        Some("run:one".to_string()),
        Vec::new(),
        None,
    );

    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let running = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(running.contains("First update."));
    assert!(running.contains("Second update."));
    assert!(running.contains("type a request"));
    assert!(app.draft_visible());
    assert!(app.cursor_visible());

    app.finish_run(Some("run:one"), None);
    terminal.draw(|frame| app.render(frame))?;
    let finished = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(finished.contains("type a request"));
    assert!(!finished.contains("Done."));
    Ok(())
}

#[test]
fn run_activity_uses_a_blinking_block_instead_of_an_ellipsis(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.dispatch(Action::Insert("do it".to_string()));
    app.dispatch(Action::Submit);
    let backend = TestBackend::new(80, 16);
    let mut terminal = Terminal::new(backend)?;

    terminal.draw(|frame| app.render_with_animation(frame, true))?;
    let lit = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(lit.contains("▌ sending"));
    assert!(!lit.contains('⋯'));

    terminal.draw(|frame| app.render_with_animation(frame, false))?;
    let dim = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(!dim.contains('▌'));
    assert!(dim.contains("sending"));
    Ok(())
}

#[test]
fn streamed_text_keeps_the_block_cursor_until_the_run_finishes(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.start_message_stream("run:one", "draft:one");
    app.append_message_delta(Some("run:one"), "draft:one", "working live");
    let backend = TestBackend::new(80, 16);
    let mut terminal = Terminal::new(backend)?;

    terminal.draw(|frame| app.render_with_animation(frame, true))?;
    let streaming = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(streaming.contains("working live▌"));

    app.finish_run(Some("run:one"), None);
    terminal.draw(|frame| app.render_with_animation(frame, true))?;
    let complete = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(complete.contains("working live"));
    assert!(!complete.contains("working live▌"));
    Ok(())
}

#[test]
fn live_actions_expand_then_collapse_into_their_run() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.dispatch(Action::Insert("inspect it".to_string()));
    app.dispatch(Action::Submit);
    app.submission_accepted(1, "run:one".to_string(), false);
    app.start_agent_action(
        "run:one",
        "execution:one",
        "Read",
        "fs.read",
        Some("macbook"),
    );
    app.start_agent_action(
        "run:one",
        "execution:one",
        "Read",
        "fs.read",
        Some("macbook"),
    );
    let backend = TestBackend::new(80, 18);
    let mut terminal = Terminal::new(backend)?;

    terminal.draw(|frame| app.render_with_animation(frame, true))?;
    let live = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(live.contains("▌ read · macbook"));
    assert!(!live.contains("thinking"));

    app.finish_agent_action("run:one", "execution:one", "completed");
    app.finish_run(Some("run:one"), None);
    terminal.draw(|frame| app.render(frame))?;
    let collapsed = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(collapsed.contains("↳ 1 action"));
    assert!(!collapsed.contains("read · macbook"));

    app.dispatch(Action::Escape);
    app.dispatch(Action::ToggleHelp);
    app.dispatch(Action::ToggleActions);
    terminal.draw(|frame| app.render(frame))?;
    let expanded = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(expanded.contains("✓ read · macbook"));
    assert!(!expanded.contains("Press ? or escape to return"));
    Ok(())
}

#[test]
fn expanded_actions_follow_message_delivery_order_after_recovery(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut command =
        Moment::complete("command", Role::Human, "do it").with_timeline(Some(1), Some(100));
    command.run_id = Some("run:one".to_string());
    let mut first = Moment::complete("message:one", Role::Intelligence, "first reply")
        .with_timeline(Some(2), Some(300));
    first.run_id = Some("run:one".to_string());
    let mut second = Moment::complete("message:two", Role::Intelligence, "second reply")
        .with_timeline(Some(3), Some(500));
    second.run_id = Some("run:one".to_string());
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![command, first, second]);
    for (execution_id, name, started_at) in [("read", "Read", 200), ("write", "Write", 400)] {
        app.restore_agent_action(AgentActionSnapshot {
            run_id: "run:one".to_string(),
            execution_id: execution_id.to_string(),
            name: name.to_string(),
            syscall: format!("fs.{}", name.to_ascii_lowercase()),
            target: Some("macbook".to_string()),
            status: "ok".to_string(),
            live: false,
            started_at: Some(started_at),
        });
    }
    app.restore_message_delivery(MessageDeliverySnapshot {
        run_id: "run:one".to_string(),
        message_id: "message:one".to_string(),
        started_at: 300,
    });
    app.dispatch(Action::ToggleActions);

    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .chunks(80)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>();
    let row = |needle: &str| {
        rendered
            .iter()
            .position(|line| line.contains(needle))
            .expect("timeline item")
    };
    assert!(row("read · macbook") < row("first reply"));
    assert!(row("first reply") < row("write · macbook"));
    assert!(row("write · macbook") < row("second reply"));
    Ok(())
}

#[test]
fn approval_stays_inline_with_the_transcript() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![Moment::complete(
        "answer",
        Role::Intelligence,
        "still visible",
    )]);
    app.start_run("run:one");
    app.enter_approval_for(
        Some("run:one"),
        Approval {
            request_id: "approval:one".to_string(),
            syscall: "shell.exec".to_string(),
            target: "macbook".to_string(),
            preview: "rm draft.txt".to_string(),
        },
    );

    let backend = TestBackend::new(80, 20);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("still visible"));
    assert!(rendered.contains("approval required"));
    assert!(rendered.contains("rm draft.txt"));
    assert!(rendered.contains("type a request"));
    Ok(())
}

#[test]
fn escape_leaves_the_prompt_visible_in_browse_mode() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.dispatch(Action::Insert("unfinished".to_string()));
    app.dispatch(Action::Escape);
    assert!(!app.draft_visible());
    assert!(!app.cursor_visible());

    let backend = TestBackend::new(60, 12);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("you@gsv $ unfinished"));
    Ok(())
}

#[test]
fn command_history_recalls_ship_and_shell_input_and_restores_the_draft() {
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![
        Moment::complete("one", Role::Human, "first"),
        Moment::complete("two", Role::Human, "pwd").with_execution(ExecutionMode::Shell),
    ]);
    app.dispatch(Action::Insert("scratch".to_string()));

    app.dispatch(Action::PreviousCommand);
    assert_eq!(app.draft(), "pwd");
    assert_eq!(app.execution_mode(), ExecutionMode::Shell);
    app.dispatch(Action::PreviousCommand);
    assert_eq!(app.draft(), "first");
    assert_eq!(app.execution_mode(), ExecutionMode::Ship);
    app.dispatch(Action::NextCommand);
    assert_eq!(app.draft(), "pwd");
    app.dispatch(Action::NextCommand);
    assert_eq!(app.draft(), "scratch");
    assert_eq!(app.execution_mode(), ExecutionMode::Ship);
}

#[test]
fn prompt_input_wraps_from_the_terminal_left_edge() {
    let prompted = super::prompted_text_lines(
        vec![ratatui::text::Span::raw("you@gsv $ ")],
        "abcdefghijkl",
        16,
        ratatui::style::Style::new(),
        &[],
        Some(12),
    );
    let rows = prompted
        .lines
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    assert_eq!(rows, vec!["you@gsv $ abcdef", "ghijkl"]);
    assert_eq!((prompted.cursor_row, prompted.cursor_col), (1, 6));
}

#[test]
fn prompt_hierarchy_survives_terminal_and_curated_palettes(
) -> Result<(), Box<dyn std::error::Error>> {
    for theme in [Theme::Terminal, Theme::Gsv] {
        let palette = theme.palette();
        let mut app = App::new(ConnectionState::Ready);
        app.set_theme(theme);
        app.set_principal("john");
        app.set_environments(vec![CapabilityEnvironment::gsv().with_cwd("~/src")]);
        app.dispatch(Action::Insert("hello".to_string()));
        let backend = TestBackend::new(40, 12);
        let mut terminal = Terminal::new(backend)?;
        terminal.draw(|frame| app.render(frame))?;
        let buffer = terminal.backend().buffer();
        let prompt_y = (0..12)
            .find(|y| {
                (0..40)
                    .filter_map(|x| buffer.cell((x, *y)))
                    .map(|cell| cell.symbol())
                    .collect::<String>()
                    .contains("john@gsv ~/src $ hello")
            })
            .expect("prompt row");

        let principal = buffer.cell((0, prompt_y)).expect("principal cell");
        let at = buffer.cell((4, prompt_y)).expect("at cell");
        let target = buffer.cell((5, prompt_y)).expect("target cell");
        let path = buffer.cell((9, prompt_y)).expect("path cell");
        let shell = buffer.cell((15, prompt_y)).expect("shell marker cell");
        let command = buffer.cell((17, prompt_y)).expect("command cell");
        assert_eq!(principal.fg, palette.principal);
        assert_ne!(principal.fg, palette.muted);
        assert!(!principal.modifier.contains(Modifier::BOLD));
        assert_eq!(at.fg, palette.accent);
        assert!(!at.modifier.contains(Modifier::BOLD));
        assert_eq!(target.fg, palette.accent);
        assert!(target.modifier.contains(Modifier::BOLD));
        assert_eq!(path.fg, palette.path);
        assert_ne!(path.fg, palette.muted);
        assert_eq!(shell.fg, palette.foreground);
        assert!(shell.modifier.contains(Modifier::BOLD));
        assert_eq!(command.fg, palette.foreground);
        assert!(!command.modifier.contains(Modifier::BOLD));
        assert_eq!(command.bg, palette.background);
    }
    Ok(())
}

#[test]
fn a_silent_run_returns_to_the_prompt_without_fabricating_output() {
    let mut app = App::new(ConnectionState::Ready);
    app.dispatch(Action::Insert("quietly update it".to_string()));
    app.dispatch(Action::Submit);
    app.submission_accepted(1, "run:quiet".to_string(), false);
    app.finish_run(Some("run:quiet"), None);

    assert_eq!(app.moments().len(), 1);
    assert_eq!(app.moments()[0].role, Role::Human);
    assert!(app.moments().iter().all(|moment| moment.text != "Done."));
}

#[test]
fn tab_mode_executes_the_literal_command_on_the_selected_target(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.set_principal("john");
    app.set_environments(vec![
        CapabilityEnvironment::gsv(),
        CapabilityEnvironment::new("macbook", "MacBook").with_cwd("~/Downloads"),
    ]);
    app.dispatch(Action::Insert("@".to_string()));
    app.dispatch(Action::Insert("mac".to_string()));
    app.dispatch(Action::Submit);
    app.dispatch(Action::ToggleShell);
    assert_eq!(app.execution_mode(), ExecutionMode::Shell);
    app.dispatch(Action::Insert("pwd".to_string()));
    assert_eq!(
        app.dispatch(Action::Submit),
        vec![Effect::Shell {
            id: 1,
            input: "pwd".to_string(),
            target: "macbook".to_string(),
            cwd: Some("~/Downloads".to_string()),
        }]
    );
    app.append_shell_output(1, "/Users/john/Downloads\n");
    app.finish_shell(1, None);

    assert_eq!(app.moments()[0].execution, ExecutionMode::Shell);
    assert_eq!(app.moments()[1].execution, ExecutionMode::Shell);
    assert_eq!(app.moments()[1].state, MomentState::Complete);
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("john@macbook ~/Downloads $ ! pwd"));
    assert!(rendered.contains("/Users/john/Downloads"));
    assert!(rendered.contains("literal shell command"));
    let rows = terminal
        .backend()
        .buffer()
        .content()
        .chunks(80)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>();
    let output_row = rows
        .iter()
        .position(|row| row.contains("/Users/john/Downloads"))
        .expect("shell output row");
    let prompt_row = rows
        .iter()
        .position(|row| row.contains("literal shell command"))
        .expect("next prompt row");
    assert_eq!(prompt_row, output_row + 1);
    Ok(())
}

#[test]
fn render_preserves_explicit_message_line_breaks() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![Moment::complete(
        "answer",
        Role::Intelligence,
        "first line\n\nsecond line",
    )]);
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let buffer = terminal.backend().buffer();
    let first_row = buffer
        .content()
        .chunks(80)
        .position(|row| {
            row.iter()
                .map(|cell| cell.symbol())
                .collect::<String>()
                .contains("first line")
        })
        .expect("first line should be rendered");
    let second_row = buffer
        .content()
        .chunks(80)
        .position(|row| {
            row.iter()
                .map(|cell| cell.symbol())
                .collect::<String>()
                .contains("second line")
        })
        .expect("second line should be rendered");
    assert_eq!(second_row, first_row + 2);
    Ok(())
}

#[test]
fn stale_run_completion_cannot_finish_the_active_response() {
    let mut app = App::new(ConnectionState::Ready);
    app.dispatch(Action::Insert("do it".to_string()));
    app.dispatch(Action::Submit);
    app.submission_accepted(1, "run:current".to_string(), false);
    app.start_message_stream("run:current", "draft:current");
    app.append_message_delta(Some("run:current"), "draft:current", "still working");
    app.enter_approval(Approval {
        request_id: "approval:current".to_string(),
        syscall: "shell.exec".to_string(),
        target: "machine:current".to_string(),
        preview: "safe".to_string(),
    });

    app.finish_run(Some("run:old"), Some("late failure"));

    let active = app
        .moments()
        .iter()
        .find(|moment| {
            moment.run_id.as_deref() == Some("run:current") && moment.role == Role::Intelligence
        })
        .expect("active response");
    assert_eq!(active.text, "still working");
    assert_eq!(active.state, MomentState::Streaming);
    assert!(app.approval().is_some());
}

#[test]
fn identical_user_messages_reconcile_by_run_identity() {
    let mut app = App::new(ConnectionState::Ready);
    app.dispatch(Action::Insert("repeat".to_string()));
    app.dispatch(Action::Submit);
    app.submission_accepted(1, "run:first".to_string(), false);
    app.dispatch(Action::Insert("repeat".to_string()));
    app.dispatch(Action::Submit);
    app.submission_accepted(2, "run:second".to_string(), true);

    app.commit_message(
        "message:first",
        Role::Human,
        "repeat",
        Some("run:first".to_string()),
        Vec::new(),
        None,
    );

    assert!(app.moments().iter().any(
        |moment| moment.id == "message:first" && moment.run_id.as_deref() == Some("run:first")
    ));
    assert!(app.moments().iter().any(
        |moment| moment.id == "local:user:2" && moment.run_id.as_deref() == Some("run:second")
    ));
}

#[test]
fn cursor_metrics_treat_a_combining_sequence_as_one_cell() {
    let value = "e\u{301}x";
    assert_eq!(text_metrics(value, "e\u{301}".len(), 20), (0, 1, 1));
}

#[test]
fn external_labels_cannot_inject_terminal_controls() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Working);
    app.set_principal("jo\u{1b}[31mhn");
    app.set_activity(Some("ship@mac\u{1b}[2Jbook · shell.exec".to_string()));
    app.replace_history(vec![Moment::complete("one", Role::Human, "hello")]);
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("jo31mhn@gsv $ hello"));
    assert!(!rendered.contains('\u{1b}'));
    assert_eq!(
        sanitize_status("ship@mac\u{1b}[2Jbook · shell.exec"),
        "ship@mac[2Jbook · shell.exec"
    );
    Ok(())
}

#[test]
fn canonical_media_is_content_first_without_unsolicited_metadata(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![Moment::complete(
        "one",
        Role::Intelligence,
        "Here it is.",
    )
    .with_artifacts(vec![Artifact {
        kind: MediaKind::Image,
        mime_type: "image/png".to_string(),
        filename: Some("chart.png".to_string()),
        size: Some(2048),
        duration_ms: None,
        transcription: Some("a chart".to_string()),
        source: Some("gsv:/home/ship/chart.png".to_string()),
        revision: Some("sha256:one".to_string()),
    }])]);
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("▧  chart.png"));
    assert!(rendered.contains("a chart"));
    assert!(!rendered.contains("image/png"));
    assert!(!rendered.contains("2.0 KB"));
    assert!(!rendered.contains("gsv:/home/ship/chart.png"));
    assert!(!rendered.contains("sha256:one"));
    Ok(())
}

#[test]
fn media_focus_selects_the_exact_image_that_opens() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.set_inline_images(true);
    app.replace_history(vec![Moment::complete(
        "one",
        Role::Intelligence,
        "Four images.",
    )
    .with_artifacts((0..4).map(image_artifact).collect())]);
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend)?;

    app.dispatch(Action::NextMedia);
    app.dispatch(Action::NextMedia);
    app.dispatch(Action::NextMedia);
    app.dispatch(Action::ToggleMedia);
    terminal.draw(|frame| app.render(frame))?;
    assert!(app.media_expanded());
    assert_eq!(app.media_slots().len(), 1);
    assert_eq!(
        app.media_slots()[0].artifact.source.as_deref(),
        Some("gsv:/home/ship/image-2.png")
    );

    app.dispatch(Action::NextMedia);
    terminal.draw(|frame| app.render(frame))?;
    assert_eq!(
        app.media_slots()[0].artifact.source.as_deref(),
        Some("gsv:/home/ship/image-3.png")
    );

    app.dispatch(Action::Escape);
    assert!(!app.media_expanded());
    Ok(())
}

#[test]
fn media_focus_opens_the_exact_audio_artifact() {
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![Moment::complete(
        "one",
        Role::Intelligence,
        "Two clips.",
    )
    .with_artifacts(vec![audio_artifact(0), audio_artifact(1)])]);

    app.dispatch(Action::NextMedia);
    app.dispatch(Action::NextMedia);
    assert_eq!(
        app.dispatch(Action::ToggleMedia),
        vec![Effect::OpenArtifact {
            artifact: audio_artifact(1)
        }]
    );
    assert_eq!(
        app.dispatch(Action::Submit),
        vec![Effect::OpenArtifact {
            artifact: audio_artifact(1)
        }]
    );
}

#[test]
fn mixed_media_keeps_source_order_in_the_document() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.set_inline_images(true);
    app.replace_history(vec![Moment::complete(
        "one",
        Role::Intelligence,
        "Four attachments.",
    )
    .with_artifacts(vec![
        image_artifact(0),
        audio_artifact(0),
        image_artifact(1),
        audio_artifact(1),
    ])]);
    let backend = TestBackend::new(80, 48);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;

    assert_eq!(app.media_slots().len(), 2);
    let rows = terminal
        .backend()
        .buffer()
        .content()
        .chunks(80)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>();
    let first_audio = rows
        .iter()
        .position(|row| row.contains("voice-0.ogg"))
        .expect("first audio row");
    let second_audio = rows
        .iter()
        .position(|row| row.contains("voice-1.ogg"))
        .expect("second audio row");
    let first_image = usize::from(app.media_slots()[0].area.y);
    let second_image = usize::from(app.media_slots()[1].area.y);
    assert!(first_image < first_audio);
    assert!(first_audio < second_image);
    assert!(second_image < second_audio);
    Ok(())
}

#[test]
fn vertical_browse_follows_human_and_ship_media_in_document_order(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.set_inline_images(true);
    app.set_vim_enabled(true);
    app.replace_history(vec![
        Moment::complete("human", Role::Human, "inspect @image-0.png")
            .with_artifacts(vec![image_artifact(0)]),
        Moment::complete("ship-one", Role::Intelligence, "First result.")
            .with_artifacts(vec![audio_artifact(0)]),
        Moment::complete("ship-two", Role::Intelligence, "Second result.")
            .with_artifacts(vec![image_artifact(1), audio_artifact(1)]),
    ]);
    let backend = TestBackend::new(60, 16);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;

    let expected = [
        ("ship-two", Some("gsv:/home/ship/image-1.png")),
        ("ship-two", None),
        ("ship-one", Some("gsv:/home/ship/voice-0.ogg")),
        ("ship-one", None),
        ("human", Some("gsv:/home/ship/image-0.png")),
        ("human", None),
    ];
    assert_eq!(
        app.selected_artifact()
            .and_then(|artifact| artifact.source.as_deref()),
        Some("gsv:/home/ship/voice-1.ogg")
    );
    assert_eq!(
        app.dispatch(Action::ToggleMedia),
        vec![Effect::OpenArtifact {
            artifact: audio_artifact(1),
        }]
    );
    for (moment_id, source) in expected {
        app.dispatch(Action::ScrollUp);
        terminal.draw(|frame| app.render(frame))?;
        assert_eq!(app.moments[app.selected].id, moment_id);
        assert_eq!(
            app.selected_artifact()
                .and_then(|artifact| artifact.source.as_deref()),
            source
        );
    }
    let expected = [
        ("human", Some("gsv:/home/ship/image-0.png")),
        ("ship-one", None),
        ("ship-one", Some("gsv:/home/ship/voice-0.ogg")),
        ("ship-two", None),
        ("ship-two", Some("gsv:/home/ship/image-1.png")),
        ("ship-two", Some("gsv:/home/ship/voice-1.ogg")),
    ];
    for (moment_id, source) in expected {
        app.dispatch(Action::ScrollDown);
        terminal.draw(|frame| app.render(frame))?;
        assert_eq!(app.moments[app.selected].id, moment_id);
        assert_eq!(
            app.selected_artifact()
                .and_then(|artifact| artifact.source.as_deref()),
            source
        );
    }
    Ok(())
}

#[test]
fn scrolling_focuses_the_visible_turn_for_reference_actions(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![
        Moment::complete("older-human", Role::Human, "older request"),
        Moment::complete(
            "older-ship",
            Role::Intelligence,
            "Read [the old guide](https://old.example/guide).",
        ),
        Moment::complete("newer-human", Role::Human, "newer request"),
        Moment::complete("newer-ship", Role::Intelligence, "newer\nanswer"),
    ]);
    let backend = TestBackend::new(50, 8);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    app.dispatch(Action::Escape);
    app.dispatch(Action::ScrollUp);
    terminal.draw(|frame| app.render(frame))?;
    app.dispatch(Action::ScrollUp);
    terminal.draw(|frame| app.render(frame))?;

    assert_eq!(app.moments[app.selected].id, "older-ship");
    assert!(app.dispatch(Action::OpenReferences).is_empty());
    assert_eq!(
        app.dispatch(Action::Submit),
        vec![Effect::OpenUrl {
            url: "https://old.example/guide".to_string(),
        }]
    );
    Ok(())
}

#[test]
fn media_focus_scrolls_to_the_corresponding_document_block(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.set_inline_images(true);
    app.replace_history(vec![Moment::complete(
        "one",
        Role::Intelligence,
        "Four attachments.",
    )
    .with_artifacts(vec![
        image_artifact(0),
        audio_artifact(0),
        image_artifact(1),
        audio_artifact(1),
    ])]);
    app.dispatch(Action::Escape);
    app.dispatch(Action::NextMedia);
    app.dispatch(Action::NextMedia);
    app.dispatch(Action::NextMedia);
    let backend = TestBackend::new(60, 18);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;

    assert!(app
        .media_slots()
        .iter()
        .any(|slot| { slot.artifact.source.as_deref() == Some("gsv:/home/ship/image-1.png") }));
    Ok(())
}

#[test]
fn image_blocks_participate_in_scrolling_instead_of_staying_pinned(
) -> Result<(), Box<dyn std::error::Error>> {
    let body = (0..20)
        .map(|index| format!("line {index}"))
        .collect::<Vec<_>>()
        .join("\n\n");
    let moment =
        Moment::complete("one", Role::Intelligence, body).with_artifacts(vec![image_artifact(0)]);
    let backend = TestBackend::new(60, 18);
    let mut terminal = Terminal::new(backend)?;

    let mut fallback = App::new(ConnectionState::Ready);
    fallback.replace_history(vec![moment.clone()]);
    terminal.draw(|frame| fallback.render(frame))?;
    let fallback_max_scroll = fallback.last_max_scroll;

    let mut inline = App::new(ConnectionState::Ready);
    inline.set_inline_images(true);
    inline.replace_history(vec![moment]);
    terminal.draw(|frame| inline.render(frame))?;
    assert!(inline.last_max_scroll > fallback_max_scroll);
    assert_eq!(inline.media_slots().len(), 1);

    inline.dispatch(Action::Escape);
    inline.dispatch(Action::ScrollUp);
    terminal.draw(|frame| inline.render(frame))?;
    assert!(inline.media_slots().is_empty());
    assert!(!inline
        .last_browse_ranges
        .iter()
        .filter(|range| range.is_media())
        .any(|range| {
            media_is_partial(*range, inline.document_scroll, inline.last_viewport_height)
        }));
    Ok(())
}

#[test]
fn transcript_uses_the_live_terminal_width() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.set_inline_images(true);
    app.replace_history(vec![Moment::complete(
        "one",
        Role::Intelligence,
        "A responsive image.",
    )
    .with_artifacts(vec![image_artifact(0)])]);

    let backend = TestBackend::new(140, 30);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let first_width = app.media_slots()[0].area.width;
    assert_eq!(first_width, 138);

    let backend = TestBackend::new(180, 30);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    assert_eq!(app.media_slots()[0].area.width, 178);
    assert!(app.media_slots()[0].area.width > first_width);
    Ok(())
}

#[test]
fn focused_image_uses_one_accent_rail_without_a_card() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.set_theme(Theme::Terminal);
    app.set_inline_images(true);
    app.replace_history(vec![Moment::complete(
        "one",
        Role::Intelligence,
        "One image.",
    )
    .with_artifacts(vec![image_artifact(0)])]);
    let backend = TestBackend::new(60, 18);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    app.dispatch(Action::Escape);
    terminal.draw(|frame| app.render(frame))?;

    let content = app.media_slots()[0].area;
    let rail = terminal
        .backend()
        .buffer()
        .cell((content.x.saturating_sub(1), content.y))
        .expect("focus rail cell");
    assert_eq!(rail.symbol(), "│");
    assert_eq!(rail.fg, Theme::Terminal.palette().accent);
    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(['╭', '╮', '╰', '╯']
        .into_iter()
        .all(|symbol| !rendered.contains(symbol)));
    Ok(())
}

#[test]
fn help_modal_withdraws_native_media_layers() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.set_inline_images(true);
    app.set_vim_enabled(true);
    app.replace_history(vec![Moment::complete(
        "one",
        Role::Intelligence,
        "An image.",
    )
    .with_artifacts(vec![image_artifact(0)])]);
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend)?;

    terminal.draw(|frame| app.render(frame))?;
    assert_eq!(app.media_slots().len(), 1);
    app.dispatch(Action::ToggleHelp);
    terminal.draw(|frame| app.render(frame))?;
    assert!(app.media_slots().is_empty());
    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("Vim: j/k"));
    assert!(rendered.contains("Press ? or escape to return"));
    Ok(())
}

#[test]
fn abort_remains_available_while_a_modal_is_open() {
    let mut app = App::new(ConnectionState::Ready);
    app.dispatch(Action::Insert("stop this".to_string()));
    app.dispatch(Action::Submit);
    app.submission_accepted(1, "run:one".to_string(), false);
    app.dispatch(Action::ToggleHelp);

    assert_eq!(app.dispatch(Action::Abort), vec![Effect::Abort]);
}

#[test]
fn target_completion_stays_on_the_live_prompt_and_preserves_the_transcript(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.set_principal("john");
    app.set_environments(vec![
        CapabilityEnvironment::gsv(),
        CapabilityEnvironment::new("macbook", "MacBook"),
    ]);
    app.replace_history(vec![Moment::complete(
        "one",
        Role::Intelligence,
        "top marker\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight",
    )]);
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let prompt_before = terminal
        .backend()
        .buffer()
        .content()
        .chunks(80)
        .position(|row| {
            row.iter()
                .map(|cell| cell.symbol())
                .collect::<String>()
                .contains("john@gsv $ type a request")
        })
        .expect("prompt row before completion");

    app.dispatch(Action::Insert("@".to_string()));
    terminal.draw(|frame| app.render(frame))?;
    let rows = terminal
        .backend()
        .buffer()
        .content()
        .chunks(80)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect::<Vec<_>>();
    let prompt_after = rows
        .iter()
        .position(|row| row.contains("john@gsv $ @"))
        .expect("live completion prompt");

    assert_eq!(prompt_after, prompt_before);
    assert!(prompt_after > 12);
    assert!(rows.iter().any(|row| row.contains("top marker")));
    assert!(rows.iter().any(|row| row.contains("macbook")));
    Ok(())
}

#[test]
fn file_completion_resolves_and_submits_revision_bound_references() {
    let mut app = App::new(ConnectionState::Ready);
    app.set_environments(vec![
        CapabilityEnvironment::gsv(),
        CapabilityEnvironment::new("macbook", "MacBook").with_cwd("/Users/sam/Downloads"),
    ]);
    app.dispatch(Action::Insert("@".to_string()));
    app.dispatch(Action::Insert("mac".to_string()));
    app.dispatch(Action::Submit);
    app.dispatch(Action::Insert("review ".to_string()));

    assert_eq!(
        app.dispatch(Action::Insert("@".to_string())),
        vec![Effect::BrowseFiles {
            request_id: 1,
            target: "macbook".to_string(),
            directory: "/Users/sam/Downloads".to_string(),
        }]
    );
    assert_eq!(app.draft(), "review ");
    app.file_listing_loaded(
        1,
        "/Users/sam/Downloads".to_string(),
        vec![
            FileEntry {
                name: "projects".to_string(),
                path: "/Users/sam/Downloads/projects".to_string(),
                is_directory: true,
            },
            FileEntry {
                name: "notes.md".to_string(),
                path: "/Users/sam/Downloads/notes.md".to_string(),
                is_directory: false,
            },
        ],
    );
    app.dispatch(Action::Insert("nts".to_string()));
    assert_eq!(
        app.dispatch(Action::Submit),
        vec![Effect::ResolveFile {
            request_id: 1,
            target: "macbook".to_string(),
            path: "/Users/sam/Downloads/notes.md".to_string(),
            filename: "notes.md".to_string(),
        }]
    );
    let reference = file_reference("notes.md");
    app.file_reference_resolved(1, reference.clone());
    assert_eq!(app.draft(), "review @notes.md");
    assert!(!app.completion_picker_visible());

    assert_eq!(
        app.dispatch(Action::Submit),
        vec![Effect::Submit {
            id: 1,
            text: "review @notes.md".to_string(),
            target: "macbook".to_string(),
            cwd: Some("/Users/sam/Downloads".to_string()),
            references: vec![reference.clone()],
        }]
    );
    assert_eq!(app.moments()[0].artifacts.len(), 1);
    app.submission_failed(1, "offline");
    assert_eq!(app.draft(), "review @notes.md");
    assert_eq!(app.draft_references.len(), 1);
    assert_eq!(app.draft_references[0].reference, reference);
}

#[test]
fn file_references_are_independently_atomic_in_the_editor() {
    let mut app = App::new(ConnectionState::Ready);
    app.dispatch(Action::Insert("compare ".to_string()));
    app.insert_file_reference(app.draft_cursor, file_reference("one.md"));
    app.dispatch(Action::Insert(" and ".to_string()));
    app.insert_file_reference(app.draft_cursor, file_reference("two.md"));
    assert_eq!(app.draft(), "compare @one.md and @two.md");
    assert_eq!(app.draft_references.len(), 2);

    app.dispatch(Action::MoveCursorLeft);
    assert_eq!(app.draft_cursor, "compare @one.md and ".len());
    app.dispatch(Action::MoveCursorRight);
    assert_eq!(app.draft_cursor, app.draft().len());
    app.dispatch(Action::Backspace);
    assert_eq!(app.draft(), "compare @one.md and ");
    assert_eq!(app.draft_references.len(), 1);
    assert_eq!(app.draft_references[0].reference.filename, "one.md");
}

#[test]
fn at_sign_is_literal_in_shell_mode() {
    let mut app = App::new(ConnectionState::Ready);
    app.dispatch(Action::ToggleShell);
    assert!(app.dispatch(Action::Insert("@".to_string())).is_empty());
    assert_eq!(app.draft(), "@");
    assert!(!app.completion_picker_visible());
}

#[test]
fn human_file_references_render_inline_without_a_duplicate_artifact_row(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.set_theme(Theme::Terminal);
    app.replace_history(vec![Moment::complete(
        "one",
        Role::Human,
        "review @notes.md",
    )
    .with_artifacts(vec![file_reference("notes.md").artifact()])]);
    let backend = TestBackend::new(80, 20);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let rows = terminal
        .backend()
        .buffer()
        .content()
        .chunks(80)
        .collect::<Vec<_>>();
    let rendered = rows
        .iter()
        .flat_map(|row| row.iter())
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert_eq!(rendered.matches("notes.md").count(), 1);
    let (row, column) = rows
        .iter()
        .enumerate()
        .find_map(|(row, cells)| {
            let text = cells.iter().map(|cell| cell.symbol()).collect::<String>();
            text.find("@notes.md").map(|column| (row, column))
        })
        .expect("inline reference");
    let cell = &rows[row][column];
    assert_eq!(cell.fg, Theme::Terminal.palette().path);
    assert!(cell.modifier.contains(Modifier::UNDERLINED));
    Ok(())
}

#[test]
fn human_image_references_keep_the_token_and_render_the_image(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.set_inline_images(true);
    app.replace_history(vec![Moment::complete(
        "one",
        Role::Human,
        "what is @image-0.png?",
    )
    .with_artifacts(vec![image_artifact(0)])]);
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();

    assert!(rendered.contains("@image-0.png"));
    assert_eq!(app.media_slots().len(), 1);
    assert_eq!(app.media_slots()[0].artifact, image_artifact(0));
    Ok(())
}

#[test]
fn completion_overlay_withdraws_intersecting_native_image_layers(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.set_inline_images(true);
    app.set_environments(
        std::iter::once(CapabilityEnvironment::gsv())
            .chain(
                (0..8)
                    .map(|index| CapabilityEnvironment::new(format!("machine-{index}"), "machine")),
            )
            .collect(),
    );
    app.replace_history(vec![Moment::complete("one", Role::Intelligence, "image")
        .with_artifacts(vec![image_artifact(0)])]);
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    assert_eq!(app.media_slots().len(), 1);

    app.dispatch(Action::Insert("@".to_string()));
    terminal.draw(|frame| app.render(frame))?;
    assert!(app.media_slots().is_empty());
    Ok(())
}

#[test]
fn target_picker_changes_both_prompt_and_submission_context(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut app = App::new(ConnectionState::Ready);
    app.set_principal("john");
    app.set_environments(vec![CapabilityEnvironment::new("macbook", "macbook")]);
    app.dispatch(Action::Insert("@".to_string()));
    assert!(app.environment_picker_visible());
    app.dispatch(Action::Insert("mac".to_string()));
    app.dispatch(Action::Submit);
    assert_eq!(app.active_environment().target, "macbook");
    app.dispatch(Action::Insert("open downloads".to_string()));
    assert_eq!(
        app.dispatch(Action::Submit),
        vec![Effect::Submit {
            id: 1,
            text: "open downloads".to_string(),
            target: "macbook".to_string(),
            cwd: None,
            references: Vec::new(),
        }]
    );
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend)?;
    terminal.draw(|frame| app.render(frame))?;
    let rendered = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(rendered.contains("john@macbook $ open downloads"));
    Ok(())
}

#[test]
fn approval_display_is_sanitized_without_changing_its_correlation_id() {
    let mut app = App::new(ConnectionState::Ready);
    app.enter_approval(Approval {
        request_id: "request\u{1b}:exact".to_string(),
        syscall: "shell\u{1b}[31m.exec".to_string(),
        target: "mac\nbook".to_string(),
        preview: "one\u{1b}[2J\ntwo".to_string(),
    });
    let approval = app.approval().expect("approval");
    assert_eq!(approval.request_id, "request\u{1b}:exact");
    assert_eq!(approval.syscall, "shell[31m.exec");
    assert_eq!(approval.target, "macbook");
    assert_eq!(approval.preview, "one[2J\ntwo");
}

#[test]
fn reaching_the_top_requests_each_history_page_once() {
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![
        Moment::complete("three", Role::Human, "three").with_timeline(Some(3), Some(30)),
        Moment::complete("four", Role::Intelligence, "four").with_timeline(Some(4), Some(40)),
    ]);
    app.set_history_has_more(true);
    app.follow_latest = false;
    app.document_scroll = 0;

    assert_eq!(
        app.dispatch(Action::ScrollUp),
        vec![Effect::LoadOlderHistory { before_sequence: 3 }]
    );
    assert!(app.dispatch(Action::ScrollUp).is_empty());
}

#[test]
fn prepending_history_deduplicates_and_preserves_the_draft() {
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![
        Moment::complete("three", Role::Human, "three").with_timeline(Some(3), Some(30)),
        Moment::complete("four", Role::Intelligence, "four").with_timeline(Some(4), Some(40)),
    ]);
    app.dispatch(Action::Insert("unfinished thought".to_string()));
    app.prepend_history(
        vec![
            Moment::complete("one", Role::Human, "one").with_timeline(Some(1), Some(10)),
            Moment::complete("two", Role::Intelligence, "two").with_timeline(Some(2), Some(20)),
            Moment::complete("three", Role::Human, "three").with_timeline(Some(3), Some(30)),
        ],
        false,
    );

    assert_eq!(
        app.moments()
            .iter()
            .map(|moment| moment.id.as_str())
            .collect::<Vec<_>>(),
        vec!["one", "two", "three", "four"]
    );
    assert_eq!(app.draft(), "unfinished thought");
}

#[test]
fn reconnect_restores_an_unconfirmed_request_until_history_confirms_it() {
    let mut app = App::new(ConnectionState::Ready);
    app.dispatch(Action::Insert("do the thing".to_string()));
    app.dispatch(Action::Submit);

    app.connection_lost();
    assert_eq!(app.draft(), "do the thing");
    assert!(app
        .moments()
        .iter()
        .any(|moment| { moment.id == "local:gsv:1" && moment.state == MomentState::Error }));

    app.reconcile_history(
        vec![
            Moment::complete("canonical-user", Role::Human, "do the thing")
                .with_timeline(Some(12), Some(120)),
        ],
        false,
    );

    assert!(app.draft().is_empty());
    assert_eq!(
        app.moments()
            .iter()
            .filter(|moment| moment.role == Role::Human)
            .count(),
        1
    );
    assert!(!app
        .moments()
        .iter()
        .any(|moment| moment.id == "local:gsv:1"));
}

#[test]
fn reverse_search_accepts_a_fuzzy_command_and_escape_restores_the_draft() {
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![
        Moment::complete("one", Role::Human, "open downloads"),
        Moment::complete("two", Role::Intelligence, "done"),
        Moment::complete("three", Role::Human, "show calendar"),
    ]);
    app.dispatch(Action::Insert("unfinished".to_string()));
    app.dispatch(Action::BeginCommandSearch);
    app.dispatch(Action::Insert("dwn".to_string()));
    app.dispatch(Action::Submit);
    assert_eq!(app.draft(), "open downloads");

    app.dispatch(Action::BeginCommandSearch);
    app.dispatch(Action::Insert("cal".to_string()));
    app.dispatch(Action::Escape);
    assert_eq!(app.draft(), "open downloads");

    app.dispatch(Action::Escape);
    app.dispatch(Action::BeginCommandSearch);
    app.dispatch(Action::Escape);
    assert!(!app.draft_visible());
}

#[test]
fn transcript_search_jumps_between_matching_messages_without_touching_the_draft() {
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![
        Moment::complete("one", Role::Human, "first needle"),
        Moment::complete("two", Role::Intelligence, "middle"),
        Moment::complete("three", Role::Human, "newest needle"),
        Moment::complete("four", Role::Intelligence, "done"),
    ]);
    app.dispatch(Action::Insert("kept draft".to_string()));
    app.dispatch(Action::Escape);
    app.dispatch(Action::BeginTranscriptSearch);
    app.dispatch(Action::Insert("needle".to_string()));
    assert_eq!(app.selected(), 2);
    app.dispatch(Action::Submit);
    assert!(!app.draft_visible());
    app.dispatch(Action::NextTranscriptMatch);
    assert_eq!(app.selected(), 0);
    assert_eq!(app.draft(), "kept draft");
}

#[test]
fn fuzzy_scoring_rewards_boundaries_and_consecutive_matches() {
    let exact = fuzzy_score("rep", "reports/final.png").expect("exact match");
    let scattered = fuzzy_score("rep", "really-expansive-picture.png").expect("scattered match");
    assert!(exact > scattered);
    assert!(fuzzy_score("rpn", "reports/final.png").is_some());
    assert!(fuzzy_score("xyz", "reports/final.png").is_none());
}

#[test]
fn selected_turn_references_open_urls_and_resolve_paths_on_the_origin_target() {
    let mut app = App::new(ConnectionState::Ready);
    app.replace_history(vec![
        Moment::complete("one", Role::Human, "inspect these")
            .with_environment(
                CapabilityEnvironment::new("macbook", "MacBook")
                    .with_cwd("/Users/sam/project"),
            ),
        Moment::complete(
            "two",
            Role::Intelligence,
            "See [the guide](https://example.com/guide), `../report.png`, and `phone:/sdcard/voice.ogg`.",
        ),
    ]);
    app.dispatch(Action::Escape);

    assert!(app.dispatch(Action::OpenReferences).is_empty());
    assert_eq!(
        app.dispatch(Action::Submit),
        vec![Effect::OpenUrl {
            url: "https://example.com/guide".to_string(),
        }]
    );

    app.dispatch(Action::OpenReferences);
    app.dispatch(Action::NextChoice);
    assert_eq!(
        app.dispatch(Action::Submit),
        vec![Effect::OpenPath {
            target: "macbook".to_string(),
            path: "/Users/sam/report.png".to_string(),
            filename: "report.png".to_string(),
        }]
    );

    app.dispatch(Action::OpenReferences);
    app.dispatch(Action::NextChoice);
    app.dispatch(Action::NextChoice);
    assert_eq!(
        app.dispatch(Action::Submit),
        vec![Effect::OpenPath {
            target: "phone".to_string(),
            path: "/sdcard/voice.ogg".to_string(),
            filename: "voice.ogg".to_string(),
        }]
    );
}
