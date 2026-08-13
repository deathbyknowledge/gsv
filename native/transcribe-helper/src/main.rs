mod audio;
mod model;
mod protocol;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use audio::{
    list_input_devices, AudioCapture, AudioError, AudioPacket, InputDeviceInfo,
    InputDeviceMatchPolicy, Resampler,
};
use crossbeam_channel::{Receiver, TryRecvError};
use model::{Engine, LoadError};
use protocol::{emit, Command, ErrorCode, Event, Phase};
use transcribe_cpp::{ParakeetStreamOptions, RunOptions, Stream, StreamExtension, StreamOptions};

const FEED_SAMPLES: usize = 1_280;
const MAX_SESSION_DURATION: Duration = Duration::from_secs(10 * 60);
const MAX_TRANSCRIPT_BYTES: usize = 64 * 1024;
const ENGINE_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const PREPARATION_POLL: Duration = Duration::from_millis(20);
const DISCOVERY_POLL: Duration = Duration::from_millis(20);

const _: () = {
    assert!(MAX_SESSION_DURATION.as_secs() <= 10 * 60);
    assert!(MAX_TRANSCRIPT_BYTES <= 64 * 1024);
    assert!(ENGINE_IDLE_TIMEOUT.as_secs() <= 5 * 60);
};

enum StreamOutcome {
    Continue,
    Shutdown,
}

#[derive(Clone)]
struct StartRequest {
    request_id: u64,
    locale: String,
    device: Option<String>,
    device_id: Option<String>,
    device_match: InputDeviceMatchPolicy,
}

enum PreparationMessage {
    State { phase: Phase, progress: Option<f32> },
    Complete(Result<Engine, LoadError>),
}

struct Preparation {
    cancelled: Arc<AtomicBool>,
    messages: Receiver<PreparationMessage>,
    request: Option<StartRequest>,
    last_state: Option<(Phase, Option<f32>)>,
}

type DeviceDiscoveryResult = Result<Vec<InputDeviceInfo>, String>;

struct DeviceDiscovery {
    request_id: Option<u64>,
    results: Receiver<DeviceDiscoveryResult>,
    worker: std::thread::JoinHandle<()>,
}

struct DeviceDiscoveryCompletion {
    request_id: Option<u64>,
    result: Result<Vec<InputDeviceInfo>, ErrorCode>,
}

fn main() {
    lower_process_priority();
    emit(&Event::Hello {
        protocol_version: protocol::VOICE_PROTOCOL_VERSION,
    });
    let commands = protocol::read_commands();
    let mut engine: Option<Engine> = None;
    let mut preparation: Option<Preparation> = None;
    let mut discovery: Option<DeviceDiscovery> = None;
    let mut engine_last_used = Instant::now();

    loop {
        if let Some(outcome) = poll_preparation(&mut preparation) {
            let PreparationOutcome {
                result,
                request,
                was_cancelled,
            } = outcome;
            match result {
                Ok(loaded) => {
                    engine = Some(loaded);
                    engine_last_used = Instant::now();
                    if let Some(request) = request {
                        let Some(loaded) = engine.as_mut() else {
                            continue;
                        };
                        if run_and_report(&request, loaded, &commands) {
                            break;
                        }
                        engine_last_used = Instant::now();
                    }
                }
                Err(_) if was_cancelled => {
                    // A new request arrived while the cancelled preparation
                    // worker was unwinding. Give that request a fresh worker;
                    // it can safely resume a validated partial download.
                    if let Some(request) = request {
                        preparation = start_preparation(request);
                    }
                }
                Err(LoadError::Cancelled) => {}
                Err(LoadError::Failed(code)) => {
                    if let Some(request) = request {
                        emit(&Event::Error {
                            request_id: Some(request.request_id),
                            code,
                        });
                    }
                }
            }
            continue;
        }

        let command = if preparation.is_some() {
            match commands.recv_timeout(PREPARATION_POLL) {
                Ok(command) => command,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => Command::Shutdown,
            }
        } else if discovery.is_some() {
            let timeout = if engine.is_some() {
                let remaining = ENGINE_IDLE_TIMEOUT.saturating_sub(engine_last_used.elapsed());
                if remaining.is_zero() {
                    engine = None;
                    continue;
                }
                DISCOVERY_POLL.min(remaining)
            } else {
                DISCOVERY_POLL
            };
            match commands.recv_timeout(timeout) {
                Ok(command) => command,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                    if let Some(completion) = poll_device_discovery(&mut discovery) {
                        report_device_discovery(completion);
                    }
                    continue;
                }
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => Command::Shutdown,
            }
        } else if engine.is_some() {
            let remaining = ENGINE_IDLE_TIMEOUT.saturating_sub(engine_last_used.elapsed());
            match commands.recv_timeout(remaining) {
                Ok(command) => command,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                    engine = None;
                    continue;
                }
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => Command::Shutdown,
            }
        } else {
            match commands.recv() {
                Ok(command) => command,
                Err(_) => Command::Shutdown,
            }
        };

        match command {
            Command::Start {
                request_id,
                locale,
                device,
                device_id,
                exact_device,
            } => {
                let request = StartRequest {
                    request_id,
                    locale,
                    device,
                    device_id,
                    device_match: if exact_device {
                        InputDeviceMatchPolicy::UniqueExactPublicName
                    } else {
                        InputDeviceMatchPolicy::LegacyFuzzyName
                    },
                };
                if discovery.is_some() {
                    emit(&Event::Error {
                        request_id: Some(request_id),
                        code: ErrorCode::Busy,
                    });
                } else if let Some(active) = preparation.as_mut() {
                    if active.request.is_some() {
                        emit(&Event::Error {
                            request_id: Some(request_id),
                            code: ErrorCode::Busy,
                        });
                    } else {
                        active.request = Some(request);
                        if let Some((phase, progress)) = active.last_state {
                            emit(&Event::State {
                                request_id,
                                phase,
                                progress,
                            });
                        }
                    }
                } else if let Some(loaded) = engine.as_mut() {
                    if run_and_report(&request, loaded, &commands) {
                        break;
                    }
                    engine_last_used = Instant::now();
                } else {
                    preparation = start_preparation(request);
                }
            }
            Command::Stop { request_id } => {
                let cancelled = cancel_preparation(&mut preparation, request_id);
                if cancelled {
                    emit(&Event::Cancelled { request_id });
                } else {
                    emit(&Event::Error {
                        request_id: Some(request_id),
                        code: ErrorCode::NotActive,
                    });
                }
            }
            Command::Cancel { request_id } => {
                let cancelled = cancel_device_discovery(&mut discovery, request_id)
                    || cancel_preparation(&mut preparation, request_id);
                if cancelled {
                    emit(&Event::Cancelled { request_id });
                } else {
                    emit(&Event::Error {
                        request_id: Some(request_id),
                        code: ErrorCode::NotActive,
                    });
                }
            }
            Command::ListDevices { request_id } => {
                if preparation.is_some() {
                    emit(&Event::Error {
                        request_id: Some(request_id),
                        code: ErrorCode::Busy,
                    });
                } else if let Err(code) =
                    start_device_discovery(&mut discovery, request_id, list_input_devices)
                {
                    emit(&Event::Error {
                        request_id: Some(request_id),
                        code,
                    });
                }
            }
            Command::Shutdown => {
                if let Some(active) = preparation.as_ref() {
                    active.cancelled.store(true, Ordering::Release);
                }
                break;
            }
        }
    }
}

fn start_device_discovery(
    discovery: &mut Option<DeviceDiscovery>,
    request_id: u64,
    enumerate: impl FnOnce() -> DeviceDiscoveryResult + Send + 'static,
) -> Result<(), ErrorCode> {
    if discovery.is_some() {
        return Err(ErrorCode::Busy);
    }
    let (results, messages) = crossbeam_channel::bounded(1);
    let worker = std::thread::Builder::new()
        .name("gsv-voice-devices".to_string())
        .spawn(move || {
            let _ = results.try_send(enumerate());
        })
        .map_err(|_| ErrorCode::MicrophoneUnavailable)?;
    *discovery = Some(DeviceDiscovery {
        request_id: Some(request_id),
        results: messages,
        worker,
    });
    Ok(())
}

fn cancel_device_discovery(discovery: &mut Option<DeviceDiscovery>, request_id: u64) -> bool {
    discovery.as_mut().is_some_and(|active| {
        if active.request_id == Some(request_id) {
            active.request_id = None;
            true
        } else {
            false
        }
    })
}

fn poll_device_discovery(
    discovery: &mut Option<DeviceDiscovery>,
) -> Option<DeviceDiscoveryCompletion> {
    let result = match discovery.as_ref()?.results.try_recv() {
        Ok(result) => result.map_err(|_| ErrorCode::MicrophoneUnavailable),
        Err(TryRecvError::Empty) => return None,
        Err(TryRecvError::Disconnected) => Err(ErrorCode::MicrophoneUnavailable),
    };
    let active = discovery.take()?;
    let _ = active.worker.join();
    Some(DeviceDiscoveryCompletion {
        request_id: active.request_id,
        result,
    })
}

fn report_device_discovery(completion: DeviceDiscoveryCompletion) {
    let Some(request_id) = completion.request_id else {
        return;
    };
    match completion.result {
        Ok(devices) => emit(&Event::Devices {
            request_id,
            devices: &devices,
        }),
        Err(code) => emit(&Event::Error {
            request_id: Some(request_id),
            code,
        }),
    }
}

fn cancel_preparation(preparation: &mut Option<Preparation>, request_id: u64) -> bool {
    preparation.as_mut().is_some_and(|active| {
        if active
            .request
            .as_ref()
            .is_some_and(|request| request.request_id == request_id)
        {
            active.cancelled.store(true, Ordering::Release);
            active.request = None;
            true
        } else {
            false
        }
    })
}

struct PreparationOutcome {
    result: Result<Engine, LoadError>,
    request: Option<StartRequest>,
    was_cancelled: bool,
}

fn start_preparation(request: StartRequest) -> Option<Preparation> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let (updates, messages) = crossbeam_channel::bounded(8);
    let worker = std::thread::Builder::new()
        .name("gsv-voice-prepare".to_string())
        .spawn(move || {
            let result = Engine::load(&worker_cancelled, |phase, progress| {
                let _ = updates.try_send(PreparationMessage::State { phase, progress });
            });
            // Completion owns the only terminal outcome and must not be dropped behind phase
            // updates. The main loop drains this bounded channel every 20ms.
            let _ = updates.send(PreparationMessage::Complete(result));
        });
    match worker {
        Ok(_) => Some(Preparation {
            cancelled,
            messages,
            request: Some(request),
            last_state: None,
        }),
        Err(_) => {
            emit(&Event::Error {
                request_id: Some(request.request_id),
                code: ErrorCode::EngineFailed,
            });
            None
        }
    }
}

fn poll_preparation(preparation: &mut Option<Preparation>) -> Option<PreparationOutcome> {
    loop {
        let message = preparation.as_ref()?.messages.try_recv();
        match message {
            Ok(PreparationMessage::State { phase, progress }) => {
                let active = preparation.as_mut()?;
                let progress = progress
                    .filter(|value| value.is_finite())
                    .map(|value| value.clamp(0.0, 1.0));
                active.last_state = Some((phase, progress));
                if let Some(request) = active.request.as_ref() {
                    emit(&Event::State {
                        request_id: request.request_id,
                        phase,
                        progress,
                    });
                }
            }
            Ok(PreparationMessage::Complete(result)) => {
                let active = preparation.take()?;
                return Some(PreparationOutcome {
                    result,
                    request: active.request,
                    was_cancelled: active.cancelled.load(Ordering::Acquire),
                });
            }
            Err(TryRecvError::Empty) => return None,
            Err(TryRecvError::Disconnected) => {
                let active = preparation.take()?;
                return Some(PreparationOutcome {
                    result: Err(LoadError::Failed(ErrorCode::Interrupted)),
                    request: active.request,
                    was_cancelled: active.cancelled.load(Ordering::Acquire),
                });
            }
        }
    }
}

fn run_and_report(
    request: &StartRequest,
    engine: &mut Engine,
    commands: &Receiver<Command>,
) -> bool {
    engine.cancel.reset();
    match run_stream(
        request.request_id,
        &request.locale,
        request.device.as_deref(),
        request.device_id.as_deref(),
        request.device_match,
        engine,
        commands,
    ) {
        Ok(StreamOutcome::Continue) => false,
        Ok(StreamOutcome::Shutdown) => true,
        Err(code) => {
            emit(&Event::Error {
                request_id: Some(request.request_id),
                code,
            });
            false
        }
    }
}

fn run_stream(
    request_id: u64,
    locale: &str,
    device: Option<&str>,
    device_id: Option<&str>,
    device_match: InputDeviceMatchPolicy,
    engine: &mut Engine,
    commands: &Receiver<Command>,
) -> Result<StreamOutcome, ErrorCode> {
    let capture = AudioCapture::open(device, device_id, device_match)
        .map_err(|_| ErrorCode::MicrophoneUnavailable)?;
    let mut resampler =
        Resampler::new(capture.sample_rate).map_err(|_| ErrorCode::MicrophoneUnavailable)?;
    let run_options = RunOptions {
        language: normalize_locale(locale),
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
        .map_err(|_| ErrorCode::EngineFailed)?;
    emit(&Event::State {
        request_id,
        phase: Phase::Listening,
        progress: None,
    });

    let mut pending = VecDeque::<f32>::with_capacity(FEED_SAMPLES * 2);
    let mut converted = Vec::with_capacity(FEED_SAMPLES * 2);
    let session_started = Instant::now();
    loop {
        crossbeam_channel::select! {
            recv(commands) -> command => {
                match command {
                    Ok(Command::Stop { request_id: stopped }) if stopped == request_id => {
                        emit(&Event::State {
                            request_id,
                            phase: Phase::Finishing,
                            progress: None,
                        });
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
                        code: ErrorCode::Busy,
                    }),
                    Ok(Command::ListDevices { request_id: other }) => {
                        emit(&Event::Error {
                            request_id: Some(other),
                            code: ErrorCode::Busy,
                        });
                    }
                    Ok(Command::Stop { request_id: other }) | Ok(Command::Cancel { request_id: other }) => {
                        emit(&Event::Error {
                            request_id: Some(other),
                            code: ErrorCode::NotActive,
                        });
                    }
                }
            }
            recv(capture.packets) -> packet => {
                match packet {
                    Ok(AudioPacket::Samples(samples)) => {
                        converted.clear();
                        resampler.push(samples.as_slice(), &mut converted);
                        pending.extend(converted.iter().copied());
                        while pending.len() >= FEED_SAMPLES {
                            let frame = pending.drain(..FEED_SAMPLES).collect::<Vec<_>>();
                            let update = stream.feed(&frame).map_err(|_| ErrorCode::EngineFailed)?;
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
                            if changed {
                                let text = stream.text();
                                emit(&Event::Partial {
                                    request_id,
                                    revision: update.revision,
                                    committed: &text.committed,
                                    tentative: &text.tentative,
                                });
                            }
                        }
                    }
                    Ok(AudioPacket::Error(AudioError::Unavailable)) | Err(_) => {
                        stream.reset();
                        return Err(ErrorCode::MicrophoneUnavailable);
                    }
                    Ok(AudioPacket::Error(AudioError::Silent)) => {
                        stream.reset();
                        return Err(ErrorCode::MicrophoneSilent);
                    }
                    Ok(AudioPacket::Error(AudioError::Overflow)) => {
                        stream.reset();
                        return Err(ErrorCode::AudioOverflow);
                    }
                }
            }
        }
    }
}

fn finish_stream(
    stream: &mut Stream<'_>,
    pending: &mut VecDeque<f32>,
) -> Result<String, ErrorCode> {
    if !pending.is_empty() {
        let final_audio = pending.drain(..).collect::<Vec<_>>();
        stream
            .feed(&final_audio)
            .map_err(|_| ErrorCode::EngineFailed)?;
    }
    stream.finalize().map_err(|_| ErrorCode::EngineFailed)?;
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

fn normalize_locale(locale: &str) -> Option<String> {
    let locale = locale.trim();
    if locale.is_empty() || locale.eq_ignore_ascii_case("auto") {
        None
    } else {
        Some(locale.to_string())
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

    fn wait_for_discovery(discovery: &mut Option<DeviceDiscovery>) -> DeviceDiscoveryCompletion {
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if let Some(completion) = poll_device_discovery(discovery) {
                return completion;
            }
            assert!(Instant::now() < deadline, "discovery worker timed out");
            std::thread::yield_now();
        }
    }

    #[test]
    fn automatic_language_is_none_and_explicit_locale_is_preserved() {
        assert_eq!(normalize_locale(""), None);
        assert_eq!(normalize_locale(" auto "), None);
        assert_eq!(normalize_locale("AUTO"), None);
        assert_eq!(normalize_locale(" nl-NL "), Some("nl-NL".to_string()));
    }

    #[test]
    fn preparation_cancellation_is_immediate_and_request_scoped() {
        let (_updates, messages) = crossbeam_channel::unbounded();
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut preparation = Some(Preparation {
            cancelled: Arc::clone(&cancelled),
            messages,
            request: Some(StartRequest {
                request_id: 17,
                locale: "auto".to_string(),
                device: None,
                device_id: None,
                device_match: InputDeviceMatchPolicy::LegacyFuzzyName,
            }),
            last_state: Some((Phase::Downloading, Some(0.2))),
        });

        assert!(!cancel_preparation(&mut preparation, 16));
        assert!(!cancelled.load(Ordering::Acquire));
        assert!(cancel_preparation(&mut preparation, 17));
        assert!(cancelled.load(Ordering::Acquire));
        assert!(preparation
            .as_ref()
            .is_some_and(|active| active.request.is_none()));
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

    #[test]
    fn device_discovery_runs_off_main_and_cancel_ignores_its_late_result() {
        let main_thread = std::thread::current().id();
        let (started, worker_started) = crossbeam_channel::bounded(1);
        let (release, released) = crossbeam_channel::bounded(1);
        let mut discovery = None;
        start_device_discovery(&mut discovery, 41, move || {
            started
                .send(std::thread::current().id())
                .expect("main owns discovery receiver");
            released.recv().expect("test releases worker");
            Ok(vec![InputDeviceInfo {
                id: "alsa:late".to_string(),
                name: "Late microphone".to_string(),
                is_default: false,
            }])
        })
        .expect("discovery starts");

        let worker_thread = worker_started
            .recv_timeout(Duration::from_secs(1))
            .expect("worker starts");
        assert_ne!(worker_thread, main_thread);
        assert!(poll_device_discovery(&mut discovery).is_none());
        assert!(!cancel_device_discovery(&mut discovery, 40));
        assert!(cancel_device_discovery(&mut discovery, 41));
        release.send(()).expect("worker is listening");

        let completion = wait_for_discovery(&mut discovery);
        assert_eq!(completion.request_id, None);
        assert!(completion.result.is_ok());
        assert!(discovery.is_none());
    }

    #[test]
    fn device_discovery_owns_at_most_one_worker() {
        let (release, released) = crossbeam_channel::bounded(1);
        let second_ran = Arc::new(AtomicBool::new(false));
        let mut discovery = None;
        start_device_discovery(&mut discovery, 51, move || {
            released.recv().expect("test releases worker");
            Ok(Vec::new())
        })
        .expect("first discovery starts");

        let second_worker_ran = Arc::clone(&second_ran);
        assert_eq!(
            start_device_discovery(&mut discovery, 52, move || {
                second_worker_ran.store(true, Ordering::Release);
                Ok(Vec::new())
            }),
            Err(ErrorCode::Busy)
        );
        assert!(!second_ran.load(Ordering::Acquire));

        release.send(()).expect("worker is listening");
        let completion = wait_for_discovery(&mut discovery);
        assert_eq!(completion.request_id, Some(51));
        assert_eq!(completion.result, Ok(Vec::new()));
    }

    #[test]
    fn device_discovery_maps_worker_failures_without_native_details() {
        let mut discovery = None;
        start_device_discovery(&mut discovery, 61, || Err("backend diagnostic".to_string()))
            .expect("discovery starts");

        let completion = wait_for_discovery(&mut discovery);
        assert_eq!(completion.request_id, Some(61));
        assert_eq!(completion.result, Err(ErrorCode::MicrophoneUnavailable));
    }
}
