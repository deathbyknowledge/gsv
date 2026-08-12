mod audio;
mod model;
mod protocol;

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use audio::{AudioCapture, AudioPacket, Resampler};
use crossbeam_channel::Receiver;
use model::Engine;
use protocol::{emit, Command, Event};
use transcribe_cpp::{ParakeetStreamOptions, RunOptions, Stream, StreamExtension, StreamOptions};

const FEED_SAMPLES: usize = 1_280;
const MIN_UI_UPDATE: Duration = Duration::from_millis(67);
const MAX_SESSION_DURATION: Duration = Duration::from_secs(10 * 60);
const MAX_TRANSCRIPT_BYTES: usize = 64 * 1024;
const ENGINE_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

const _: () = {
    assert!(MAX_SESSION_DURATION.as_secs() <= 10 * 60);
    assert!(MAX_TRANSCRIPT_BYTES <= 64 * 1024);
    assert!(ENGINE_IDLE_TIMEOUT.as_secs() <= 5 * 60);
};

enum StreamOutcome {
    Continue,
    Shutdown,
}

fn main() {
    lower_process_priority();
    let commands = protocol::read_commands();
    let mut engine: Option<Engine> = None;
    loop {
        let command = if engine.is_some() {
            match commands.recv_timeout(ENGINE_IDLE_TIMEOUT) {
                Ok(command) => command,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                    // Keep the lightweight helper available, but return the
                    // model and its native allocations after an idle period.
                    engine = None;
                    continue;
                }
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match commands.recv() {
                Ok(command) => command,
                Err(_) => break,
            }
        };
        match command {
            Command::Start { request_id, locale } => {
                if engine.is_none() {
                    match Engine::load(request_id) {
                        Ok(loaded) => engine = Some(loaded),
                        Err(message) => {
                            emit(&Event::Error {
                                request_id: Some(request_id),
                                message: &message,
                            });
                            continue;
                        }
                    }
                }
                let Some(loaded) = engine.as_mut() else {
                    continue;
                };
                loaded.cancel.reset();
                match run_stream(request_id, &locale, loaded, &commands) {
                    Ok(StreamOutcome::Continue) => {}
                    Ok(StreamOutcome::Shutdown) => break,
                    Err(message) => emit(&Event::Error {
                        request_id: Some(request_id),
                        message: &message,
                    }),
                }
            }
            Command::Stop { request_id } | Command::Cancel { request_id } => {
                emit(&Event::Error {
                    request_id: Some(request_id),
                    message: "voice input is not active",
                });
            }
            Command::Shutdown => break,
        }
    }
}

fn run_stream(
    request_id: u64,
    locale: &str,
    engine: &mut Engine,
    commands: &Receiver<Command>,
) -> Result<StreamOutcome, String> {
    let capture = AudioCapture::open()?;
    let mut resampler = Resampler::new(capture.sample_rate)?;
    let run_options = RunOptions {
        language: Some(normalize_locale(locale)),
        ..RunOptions::default()
    };
    let stream_options = StreamOptions {
        family: Some(StreamExtension::ParakeetStream(ParakeetStreamOptions {
            att_context_right: Some(3),
        })),
        ..StreamOptions::default()
    };
    let mut stream = engine
        .session
        .stream(&run_options, &stream_options)
        .map_err(|error| format!("voice input could not begin: {error}"))?;
    emit(&Event::Listening { request_id });

    let mut pending = VecDeque::<f32>::with_capacity(FEED_SAMPLES * 2);
    let mut converted = Vec::with_capacity(FEED_SAMPLES * 2);
    let mut last_ui_update = Instant::now() - MIN_UI_UPDATE;
    let session_started = Instant::now();
    loop {
        crossbeam_channel::select! {
            recv(commands) -> command => {
                match command {
                    Ok(Command::Stop { request_id: stopped }) if stopped == request_id => {
                        let final_text = finish_stream(&mut stream, &mut pending)?;
                        emit(&Event::Final { request_id, text: &final_text });
                        return Ok(StreamOutcome::Continue);
                    }
                    Ok(Command::Cancel { request_id: cancelled }) if cancelled == request_id => {
                        stream.reset();
                        emit(&Event::Cancelled { request_id });
                        return Ok(StreamOutcome::Continue);
                    }
                    Ok(Command::Shutdown) | Err(_) => {
                        stream.reset();
                        return Ok(StreamOutcome::Shutdown);
                    }
                    Ok(Command::Start { request_id: other, .. }) => emit(&Event::Error {
                        request_id: Some(other),
                        message: "voice input is already active",
                    }),
                    Ok(Command::Stop { request_id: other }) | Ok(Command::Cancel { request_id: other }) => {
                        emit(&Event::Error {
                            request_id: Some(other),
                            message: "voice input request is no longer active",
                        });
                    }
                }
            }
            recv(capture.packets) -> packet => {
                match packet {
                    Ok(AudioPacket::Samples(samples)) => {
                        converted.clear();
                        resampler.push(&samples, &mut converted);
                        pending.extend(converted.iter().copied());
                        while pending.len() >= FEED_SAMPLES {
                            let frame = pending.drain(..FEED_SAMPLES).collect::<Vec<_>>();
                            let update = stream.feed(&frame)
                                .map_err(|error| format!("voice input stopped: {error}"))?;
                            let changed = update.committed_changed || update.tentative_changed;
                            if changed || session_started.elapsed() >= MAX_SESSION_DURATION {
                                let text = stream.text();
                                if transcript_at_limit(&text.committed, &text.tentative)
                                    || session_started.elapsed() >= MAX_SESSION_DURATION
                                {
                                    drop(text);
                                    let final_text = finish_stream(&mut stream, &mut pending)?;
                                    emit(&Event::Final { request_id, text: &final_text });
                                    return Ok(StreamOutcome::Continue);
                                }
                            }
                            if changed
                                && last_ui_update.elapsed() >= MIN_UI_UPDATE
                            {
                                let text = stream.text();
                                emit(&Event::Partial {
                                    request_id,
                                    revision: update.revision,
                                    committed: &text.committed,
                                    tentative: &text.tentative,
                                });
                                last_ui_update = Instant::now();
                            }
                        }
                    }
                    Ok(AudioPacket::Error(message)) => {
                        stream.reset();
                        return Err(message);
                    }
                    Err(_) => {
                        stream.reset();
                        return Err("microphone disconnected".to_string());
                    }
                }
            }
        }
    }
}

fn finish_stream(stream: &mut Stream<'_>, pending: &mut VecDeque<f32>) -> Result<String, String> {
    if !pending.is_empty() {
        let final_audio = pending.drain(..).collect::<Vec<_>>();
        stream
            .feed(&final_audio)
            .map_err(|error| format!("voice input could not finish: {error}"))?;
    }
    stream
        .finalize()
        .map_err(|error| format!("voice input could not finish: {error}"))?;
    Ok(bounded_transcript(&stream.text().full))
}

fn transcript_at_limit(committed: &str, tentative: &str) -> bool {
    committed.len().saturating_add(tentative.len()) >= MAX_TRANSCRIPT_BYTES
}

fn bounded_transcript(text: &str) -> String {
    let text = text.trim();
    let end = text.floor_char_boundary(text.len().min(MAX_TRANSCRIPT_BYTES));
    text[..end].trim_end().to_string()
}

fn normalize_locale(locale: &str) -> String {
    let locale = locale.trim();
    if locale.is_empty() {
        "auto".to_string()
    } else {
        locale.to_string()
    }
}

#[cfg(unix)]
fn lower_process_priority() {
    // SAFETY: setpriority has no memory-safety preconditions; failure simply
    // leaves the helper at its inherited priority.
    let _ = unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, 10) };
}

#[cfg(not(unix))]
fn lower_process_priority() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_defaults_without_exposing_a_model_setting() {
        assert_eq!(normalize_locale(""), "auto");
        assert_eq!(normalize_locale(" nl-NL "), "nl-NL");
    }

    #[test]
    fn output_is_throttled_below_frame_rate() {
        assert!(MIN_UI_UPDATE >= Duration::from_millis(60));
    }

    #[test]
    fn sessions_and_snapshots_have_explicit_bounds() {
        assert!(transcript_at_limit(
            &"a".repeat(MAX_TRANSCRIPT_BYTES - 1),
            "b"
        ));
        assert!(!transcript_at_limit(
            &"a".repeat(MAX_TRANSCRIPT_BYTES - 2),
            "b"
        ));
    }

    #[test]
    fn final_text_limit_preserves_unicode_boundaries() {
        let mut text = "a".repeat(MAX_TRANSCRIPT_BYTES - 1);
        text.push('é');
        let bounded = bounded_transcript(&text);
        assert_eq!(bounded.len(), MAX_TRANSCRIPT_BYTES - 1);
        assert!(bounded.is_char_boundary(bounded.len()));
    }
}
