use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use desktop_protocol::{
    MicrophoneDevice, MicrophoneEnvironmentOverride, MicrophoneName, MicrophoneSelection,
    MicrophoneStatus, OperationError, RequestContext,
};
use gpui::{AppContext, Context, Focusable, Window};
use host_config::{CliConfig, MicrophonePreference};

use crate::model::SurfaceMode;
use crate::transcription::{VoiceCommand, VoiceErrorCode, VoiceEvent, VoicePhase};

use super::{
    compose_voice_text, ChooseMicrophone, GsvApp, NextMicrophone, PreviousMicrophone,
    SelectMicrophone, ToggleDictation,
};

const MICROPHONE_SAVE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MuteStateApplication {
    Ignored,
    Applied,
    Contradicted,
}

#[derive(Debug)]
pub(super) struct VoiceDraft {
    request_id: u64,
    segment_id: u64,
    pending_segment_commit: Option<u64>,
    before: String,
    after: String,
    pub(super) rendered: String,
    revision: i32,
    listening: bool,
    stopping: bool,
    muted: bool,
    pending_mute: Option<bool>,
    mute_revision: Option<u64>,
}

impl VoiceDraft {
    pub(super) fn new(request_id: u64, before: String, after: String, rendered: String) -> Self {
        Self {
            request_id,
            segment_id: 0,
            pending_segment_commit: None,
            before,
            after,
            rendered,
            revision: -1,
            listening: false,
            stopping: false,
            muted: false,
            pending_mute: None,
            mute_revision: None,
        }
    }

    fn can_request_segment_commit(&self) -> bool {
        !self.stopping && self.pending_segment_commit.is_none()
    }

    fn note_segment_commit_requested(&mut self) {
        debug_assert!(self.can_request_segment_commit());
        self.pending_segment_commit = Some(self.segment_id);
    }

    fn accepts_segment(&self, segment_id: u64) -> bool {
        self.segment_id == segment_id
    }

    fn awaits_segment_final(&self, segment_id: u64) -> bool {
        self.pending_segment_commit == Some(segment_id) && self.accepts_segment(segment_id)
    }

    fn begin_next_segment(&mut self, value: String, cursor: usize) {
        debug_assert!(cursor <= value.len());
        debug_assert!(value.is_char_boundary(cursor));
        self.segment_id = self.segment_id.wrapping_add(1);
        self.pending_segment_commit = None;
        self.before = value[..cursor].to_string();
        self.after = value[cursor..].to_string();
        self.rendered = value;
        self.revision = -1;
    }

    fn can_request_mute(&self, muted: bool) -> bool {
        !self.stopping
            && self.mute_revision.is_some()
            && self.pending_mute.is_none()
            && self.muted != muted
    }

    fn note_mute_requested(&mut self, muted: bool) {
        debug_assert!(self.can_request_mute(muted));
        self.pending_mute = Some(muted);
    }

    fn apply_mute_state(&mut self, revision: u64, muted: bool) -> MuteStateApplication {
        if self
            .mute_revision
            .is_some_and(|applied_revision| revision <= applied_revision)
        {
            return if self.pending_mute.take().is_some() {
                MuteStateApplication::Contradicted
            } else {
                MuteStateApplication::Ignored
            };
        }
        self.mute_revision = Some(revision);
        self.muted = muted;
        if let Some(pending_mute) = self.pending_mute.take() {
            return if pending_mute == muted {
                MuteStateApplication::Applied
            } else {
                MuteStateApplication::Contradicted
            };
        }
        MuteStateApplication::Applied
    }
}

#[derive(Debug, PartialEq, Eq)]
struct VoiceStartSelection {
    device: Option<String>,
    device_id: Option<String>,
    exact_device: bool,
}

#[derive(Debug)]
pub(super) struct MicrophoneChooser {
    pub(super) devices: Vec<crate::transcription::VoiceDevice>,
    pub(super) highlighted: usize,
    pub(super) loading: bool,
    start_after_selection: bool,
    pub(super) notice: Option<String>,
}

#[derive(Debug)]
enum MicrophoneDeviceOperation {
    Activation {
        legacy_name: Option<String>,
    },
    Chooser,
    ControlList {
        context: RequestContext,
        response: tokio::sync::oneshot::Sender<Result<MicrophoneStatus, OperationError>>,
    },
    ControlSet {
        context: RequestContext,
        response: tokio::sync::oneshot::Sender<Result<MicrophoneStatus, OperationError>>,
        preference: MicrophonePreference,
    },
}

#[derive(Debug)]
pub(super) struct PendingMicrophoneRequest {
    request_id: u64,
    operation: MicrophoneDeviceOperation,
}

enum MicrophoneSaveOwner {
    LegacyMigration,
    Chooser {
        start_after_selection: bool,
    },
    Control {
        context: RequestContext,
        response: tokio::sync::oneshot::Sender<Result<MicrophoneStatus, OperationError>>,
        devices: Vec<crate::transcription::VoiceDevice>,
    },
}

impl GsvApp {
    pub(super) fn handle_microphone_control(
        &mut self,
        context: RequestContext,
        response: tokio::sync::oneshot::Sender<Result<MicrophoneStatus, OperationError>>,
        preference: Option<MicrophonePreference>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if context.is_cancelled() || response.is_closed() {
            return;
        }
        if self.desktop_switch_pending
            || self.voice_draft.is_some()
            || self.microphone_chooser.is_some()
        {
            let _ = response.send(Err(OperationError::Busy));
            return;
        }
        let operation = match preference {
            Some(preference) => MicrophoneDeviceOperation::ControlSet {
                context,
                response,
                preference,
            },
            None => MicrophoneDeviceOperation::ControlList { context, response },
        };
        self.begin_microphone_enumeration(operation, window, cx);
    }

    fn begin_microphone_enumeration(
        &mut self,
        operation: MicrophoneDeviceOperation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.pending_microphone_request.is_some() || self.microphone_save_pending {
            self.reject_microphone_operation(operation, OperationError::Busy);
            return;
        }
        let request_id = self.next_voice_request_id;
        self.next_voice_request_id = self.next_voice_request_id.wrapping_add(1).max(1);
        let cancellation = match &operation {
            MicrophoneDeviceOperation::ControlList { context, .. }
            | MicrophoneDeviceOperation::ControlSet { context, .. } => Some(context.clone()),
            MicrophoneDeviceOperation::Activation { .. } | MicrophoneDeviceOperation::Chooser => {
                None
            }
        };
        self.pending_microphone_request = Some(PendingMicrophoneRequest {
            request_id,
            operation,
        });
        self.sync_vision_context();
        if let Some(context) = cancellation {
            self.microphone_request_cancellation = Some(cx.spawn(async move |this, cx| {
                context.cancelled().await;
                let _ = this.update(cx, |this, _| {
                    if this
                        .pending_microphone_request
                        .as_ref()
                        .is_some_and(|pending| pending.request_id == request_id)
                    {
                        this.pending_microphone_request = None;
                        let _ = this
                            .voice_commands
                            .send(VoiceCommand::Cancel { request_id });
                        this.sync_vision_context();
                        this.refresh_idle_vision_notice();
                    }
                });
            }));
        }
        if self
            .voice_commands
            .send(VoiceCommand::ListDevices { request_id })
            .is_err()
        {
            self.fail_microphone_enumeration(
                request_id,
                VoiceErrorCode::HelperUnavailable,
                window,
                cx,
            );
        }
    }

    fn reject_microphone_operation(
        &self,
        operation: MicrophoneDeviceOperation,
        error: OperationError,
    ) {
        match operation {
            MicrophoneDeviceOperation::ControlList { response, .. }
            | MicrophoneDeviceOperation::ControlSet { response, .. } => {
                let _ = response.send(Err(error));
            }
            MicrophoneDeviceOperation::Activation { .. } | MicrophoneDeviceOperation::Chooser => {}
        }
    }

    fn complete_microphone_enumeration(
        &mut self,
        request_id: u64,
        devices: Vec<crate::transcription::VoiceDevice>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(pending) = self
            .pending_microphone_request
            .take()
            .filter(|pending| pending.request_id == request_id)
        else {
            return;
        };
        self.microphone_request_cancellation = None;
        self.sync_vision_context();
        match pending.operation {
            MicrophoneDeviceOperation::Activation { legacy_name } => {
                if let Some(legacy_name) = legacy_name {
                    let mut matches = devices.iter().filter(|device| device.name == legacy_name);
                    let Some(device) = matches.next() else {
                        self.show_microphone_chooser(
                            devices,
                            true,
                            Some("SAVED MICROPHONE IS NOT AVAILABLE".to_string()),
                            window,
                            cx,
                        );
                        return;
                    };
                    if matches.next().is_some() {
                        self.show_microphone_chooser(
                            devices,
                            true,
                            Some("SAVED MICROPHONE NAME IS AMBIGUOUS".to_string()),
                            window,
                            cx,
                        );
                        return;
                    }
                    let preference = MicrophonePreference::Device {
                        id: Some(device.id.clone()),
                        name: device.name.clone(),
                    };
                    self.persist_microphone_preference(
                        preference,
                        MicrophoneSaveOwner::LegacyMigration,
                        window,
                        cx,
                    );
                } else if devices.is_empty() {
                    self.show_microphone_chooser(
                        devices,
                        true,
                        Some("NO MICROPHONES ARE AVAILABLE".to_string()),
                        window,
                        cx,
                    );
                } else {
                    self.show_microphone_chooser(devices, true, None, window, cx);
                }
            }
            MicrophoneDeviceOperation::Chooser => {
                if let Some(chooser) = self.microphone_chooser.as_mut() {
                    chooser.highlighted =
                        preferred_microphone_index(&devices, &self.microphone_preference);
                    chooser.devices = devices;
                    chooser.loading = false;
                    if chooser.devices.is_empty() && chooser.notice.is_none() {
                        chooser.notice = Some("NO MICROPHONES ARE AVAILABLE".to_string());
                    }
                    self.microphone_focus.focus(window);
                    cx.notify();
                }
            }
            MicrophoneDeviceOperation::ControlList { context, response } => {
                if context.is_cancelled() || response.is_closed() {
                    return;
                }
                let _ = response.send(self.microphone_status(&devices));
            }
            MicrophoneDeviceOperation::ControlSet {
                context,
                response,
                preference,
            } => {
                if context.is_cancelled() || response.is_closed() {
                    return;
                }
                let preference = if let MicrophonePreference::Device { name, .. } = preference {
                    let mut matches = devices.iter().filter(|device| device.name == name);
                    let Some(device) = matches.next() else {
                        let _ = response.send(Err(OperationError::Conflict));
                        return;
                    };
                    if matches.next().is_some() {
                        let _ = response.send(Err(OperationError::Conflict));
                        return;
                    }
                    MicrophonePreference::Device {
                        id: Some(device.id.clone()),
                        name: device.name.clone(),
                    }
                } else {
                    preference
                };
                self.persist_microphone_preference(
                    preference,
                    MicrophoneSaveOwner::Control {
                        context,
                        response,
                        devices,
                    },
                    window,
                    cx,
                );
            }
        }
    }

    fn fail_microphone_enumeration(
        &mut self,
        request_id: u64,
        code: VoiceErrorCode,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(pending) = self
            .pending_microphone_request
            .take()
            .filter(|pending| pending.request_id == request_id)
        else {
            return;
        };
        self.microphone_request_cancellation = None;
        self.sync_vision_context();
        match pending.operation {
            MicrophoneDeviceOperation::Activation { .. } => {
                self.show_microphone_chooser(
                    Vec::new(),
                    true,
                    Some(voice_error_notice(code).to_string()),
                    window,
                    cx,
                );
            }
            MicrophoneDeviceOperation::Chooser => {
                if let Some(chooser) = self.microphone_chooser.as_mut() {
                    chooser.loading = false;
                    chooser.notice = Some("MICROPHONES COULD NOT BE READ · TRY AGAIN".to_string());
                    self.microphone_focus.focus(window);
                }
            }
            MicrophoneDeviceOperation::ControlList { response, .. }
            | MicrophoneDeviceOperation::ControlSet { response, .. } => {
                let error = if code == VoiceErrorCode::Busy {
                    OperationError::Busy
                } else {
                    OperationError::Unavailable
                };
                let _ = response.send(Err(error));
            }
        }
        cx.notify();
    }

    fn microphone_status(
        &self,
        devices: &[crate::transcription::VoiceDevice],
    ) -> Result<MicrophoneStatus, OperationError> {
        let devices = microphone_status_devices(devices)?;
        let selected = match &self.microphone_preference {
            MicrophonePreference::Ask => MicrophoneSelection::Ask,
            MicrophonePreference::SystemDefault => MicrophoneSelection::SystemDefault,
            MicrophonePreference::Device { name, .. } => MicrophoneSelection::Device {
                name: MicrophoneName::new(name.clone()).map_err(|_| OperationError::Internal)?,
            },
        };
        let environment_override = match environment_voice_device() {
            Ok(Some(name)) => Some(MicrophoneEnvironmentOverride::Active {
                name: MicrophoneName::new(name).map_err(|_| OperationError::Internal)?,
            }),
            Err(()) => Some(MicrophoneEnvironmentOverride::Invalid),
            Ok(None) => None,
        };
        MicrophoneStatus::new(devices, selected, environment_override)
            .map_err(|_| OperationError::Internal)
    }

    fn show_microphone_chooser(
        &mut self,
        devices: Vec<crate::transcription::VoiceDevice>,
        start_after_selection: bool,
        notice: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let highlighted = preferred_microphone_index(&devices, &self.microphone_preference);
        self.voice_notice = None;
        self.microphone_chooser = Some(MicrophoneChooser {
            devices,
            highlighted,
            loading: false,
            start_after_selection,
            notice,
        });
        self.sync_vision_context();
        self.microphone_focus.focus(window);
        cx.notify();
    }

    fn open_microphone_chooser(
        &mut self,
        start_after_selection: bool,
        notice: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.voice_draft.is_some()
            || self.pending_microphone_request.is_some()
            || self.microphone_save_pending
        {
            return;
        }
        self.voice_notice = None;
        self.microphone_chooser = Some(MicrophoneChooser {
            devices: Vec::new(),
            highlighted: 0,
            loading: true,
            start_after_selection,
            notice,
        });
        self.sync_vision_context();
        self.microphone_focus.focus(window);
        self.begin_microphone_enumeration(MicrophoneDeviceOperation::Chooser, window, cx);
        cx.notify();
    }

    fn persist_microphone_preference(
        &mut self,
        preference: MicrophonePreference,
        owner: MicrophoneSaveOwner,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.microphone_save_pending {
            return;
        }
        self.microphone_save_generation = self.microphone_save_generation.wrapping_add(1);
        let generation = self.microphone_save_generation;
        let save_cancellation = Arc::new(AtomicBool::new(false));
        self.microphone_save_cancellation = Some(save_cancellation.clone());
        self.microphone_save_pending = true;
        self.sync_vision_context();
        if let Some(chooser) = self.microphone_chooser.as_mut() {
            chooser.notice = Some("SAVING MICROPHONE".to_string());
        }
        let cancellation = match &owner {
            MicrophoneSaveOwner::Control { context, .. } => Some(context.clone()),
            MicrophoneSaveOwner::LegacyMigration | MicrophoneSaveOwner::Chooser { .. } => None,
        };
        let saved_preference = preference.clone();
        let worker_cancellation = save_cancellation.clone();
        let save = cx.background_spawn(async move {
            if worker_cancellation.load(Ordering::Acquire)
                || cancellation
                    .as_ref()
                    .is_some_and(RequestContext::is_cancelled)
            {
                return Ok(None);
            }
            CliConfig::update_if_until(
                Instant::now() + MICROPHONE_SAVE_TIMEOUT,
                || {
                    worker_cancellation.load(Ordering::Acquire)
                        || cancellation
                            .as_ref()
                            .is_some_and(RequestContext::is_cancelled)
                },
                |config| {
                    // Entering this locked update is the commit point. Cancellation
                    // before it prevents the write; after it, the atomic update may
                    // complete, but a cancelled caller receives no late response.
                    if worker_cancellation.load(Ordering::Acquire)
                        || cancellation
                            .as_ref()
                            .is_some_and(RequestContext::is_cancelled)
                    {
                        return None;
                    }
                    config.desktop.set_microphone_preference(saved_preference);
                    Some(())
                },
            )
        });
        self.microphone_save_task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = save.await;
            let _ = this.update_in(cx, |this, window, cx| {
                if this.microphone_save_generation != generation {
                    return;
                }
                this.microphone_save_pending = false;
                this.microphone_save_cancellation = None;
                match result {
                    Ok(Some(())) => {
                        this.microphone_preference = preference.clone();
                        match owner {
                            MicrophoneSaveOwner::LegacyMigration => {
                                if let Some(selection) = preference_start(&preference) {
                                    this.begin_dictation(selection, window, cx);
                                } else {
                                    this.open_microphone_chooser(
                                        true,
                                        Some("CHOOSE A MICROPHONE".to_string()),
                                        window,
                                        cx,
                                    );
                                }
                            }
                            MicrophoneSaveOwner::Chooser {
                                start_after_selection,
                            } => {
                                this.microphone_chooser = None;
                                match environment_voice_device() {
                                    Ok(Some(_)) | Err(()) => {
                                        this.voice_notice = Some(
                                            "MICROPHONE SAVED · GSV_VOICE_DEVICE REMAINS ACTIVE"
                                                .to_string(),
                                        );
                                        this.input.focus_handle(cx).focus(window);
                                    }
                                    Ok(None) if start_after_selection => {
                                        if let Some(selection) = preference_start(&preference) {
                                            this.begin_dictation(selection, window, cx);
                                        }
                                    }
                                    Ok(None) => {
                                        this.voice_notice = Some("MICROPHONE SAVED".to_string());
                                        this.input.focus_handle(cx).focus(window);
                                    }
                                }
                            }
                            MicrophoneSaveOwner::Control {
                                context,
                                response,
                                devices,
                            } => {
                                if !context.is_cancelled() && !response.is_closed() {
                                    let _ = response.send(this.microphone_status(&devices));
                                }
                            }
                        }
                    }
                    Ok(None) => {
                        let cancelled = match &owner {
                            MicrophoneSaveOwner::Control { context, .. } => context.is_cancelled(),
                            MicrophoneSaveOwner::LegacyMigration
                            | MicrophoneSaveOwner::Chooser { .. } => false,
                        } || save_cancellation.load(Ordering::Acquire);
                        if !cancelled {
                            this.report_microphone_save_failure(owner);
                        }
                    }
                    Err(_) => this.report_microphone_save_failure(owner),
                }
                this.sync_vision_context();
                this.refresh_idle_vision_notice();
                cx.notify();
            });
        }));
    }

    fn report_microphone_save_failure(&mut self, owner: MicrophoneSaveOwner) {
        match owner {
            MicrophoneSaveOwner::LegacyMigration => {
                self.voice_notice =
                    Some("MICROPHONE COULD NOT BE SAVED · CHOOSE INPUT".to_string());
            }
            MicrophoneSaveOwner::Chooser { .. } => {
                if let Some(chooser) = self.microphone_chooser.as_mut() {
                    chooser.notice = Some("MICROPHONE COULD NOT BE SAVED · TRY AGAIN".to_string());
                }
            }
            MicrophoneSaveOwner::Control { response, .. } => {
                let _ = response.send(Err(OperationError::Internal));
            }
        }
    }

    pub(super) fn choose_microphone_action(
        &mut self,
        _: &ChooseMicrophone,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.login.is_some()
            || self.desktop_switch_pending
            || self.interaction.is_approval()
            || self.interaction.is_approval_submitting()
        {
            return;
        }
        let notice = match environment_voice_device() {
            Ok(Some(name)) => Some(format!("GSV_VOICE_DEVICE ACTIVE · {name}")),
            Err(()) => Some("GSV_VOICE_DEVICE IS INVALID · REMOVE IT TO USE A SAVED INPUT".into()),
            Ok(None) => None,
        };
        self.open_microphone_chooser(false, notice, window, cx);
    }

    fn move_microphone_choice(&mut self, direction: isize, cx: &mut Context<Self>) {
        let Some(chooser) = self.microphone_chooser.as_mut() else {
            return;
        };
        let count = chooser.devices.len() + 1;
        if chooser.loading || count == 0 {
            return;
        }
        chooser.highlighted = chooser
            .highlighted
            .saturating_add_signed(direction)
            .min(count - 1);
        cx.notify();
    }

    pub(super) fn previous_microphone(
        &mut self,
        _: &PreviousMicrophone,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_microphone_choice(-1, cx);
    }

    pub(super) fn next_microphone(
        &mut self,
        _: &NextMicrophone,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.move_microphone_choice(1, cx);
    }

    pub(super) fn select_microphone_action(
        &mut self,
        _: &SelectMicrophone,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.select_highlighted_microphone(window, cx);
    }

    pub(super) fn select_microphone_at(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(chooser) = self.microphone_chooser.as_mut() else {
            return;
        };
        if chooser.loading || self.microphone_save_pending || index > chooser.devices.len() {
            return;
        }
        chooser.highlighted = index;
        let start_after_selection = chooser.start_after_selection;
        let preference = if index == 0 {
            MicrophonePreference::SystemDefault
        } else {
            let device = &chooser.devices[index - 1];
            MicrophonePreference::Device {
                id: Some(device.id.clone()),
                name: device.name.clone(),
            }
        };
        self.persist_microphone_preference(
            preference,
            MicrophoneSaveOwner::Chooser {
                start_after_selection,
            },
            window,
            cx,
        );
    }

    pub(super) fn select_highlighted_microphone(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(index) = self
            .microphone_chooser
            .as_ref()
            .map(|chooser| chooser.highlighted)
        else {
            return;
        };
        self.select_microphone_at(index, window, cx);
    }

    pub(super) fn close_microphone_chooser(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.microphone_chooser.is_none() {
            return false;
        }
        if let Some(pending) = self.pending_microphone_request.take() {
            let _ = self.voice_commands.send(VoiceCommand::Cancel {
                request_id: pending.request_id,
            });
        }
        self.microphone_request_cancellation = None;
        if self.microphone_save_pending {
            if let Some(cancellation) = self.microphone_save_cancellation.take() {
                cancellation.store(true, Ordering::Release);
            }
            self.microphone_save_generation = self.microphone_save_generation.wrapping_add(1);
            self.microphone_save_pending = false;
        }
        self.microphone_chooser = None;
        self.voice_notice = None;
        self.sync_vision_context();
        self.refresh_idle_vision_notice();
        self.input.focus_handle(cx).focus(window);
        cx.notify();
        true
    }

    pub(super) fn toggle_dictation_action(
        &mut self,
        _: &ToggleDictation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.voice_draft.is_some() {
            self.finish_dictation(cx);
            return;
        }
        self.start_dictation(window, cx);
    }

    pub(super) fn dictation_start_is_safe(&self) -> bool {
        self.voice_draft.is_none()
            && self.microphone_chooser.is_none()
            && self.pending_microphone_request.is_none()
            && !self.microphone_save_pending
            && self.login.is_none()
            && !self.desktop_switch_pending
            && self.conversation.mode == SurfaceMode::Conversation
            && !self.interaction.is_approval()
            && !self.interaction.is_submitting()
    }

    /// Starts dictation through the same Desktop-owned microphone selection
    /// path used by the keyboard action. The vision helper can request this
    /// operation, but it never selects or opens a microphone itself.
    pub(super) fn start_dictation(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.dictation_start_is_safe() {
            return false;
        }

        match environment_voice_device() {
            Ok(Some(device)) => {
                self.begin_dictation(
                    VoiceStartSelection {
                        device: Some(device),
                        device_id: None,
                        exact_device: false,
                    },
                    window,
                    cx,
                );
                return true;
            }
            Err(()) => {
                self.open_microphone_chooser(
                    false,
                    Some(
                        "GSV_VOICE_DEVICE IS INVALID · REMOVE IT TO USE A SAVED INPUT".to_string(),
                    ),
                    window,
                    cx,
                );
                return true;
            }
            Ok(None) => {}
        }
        match &self.microphone_preference {
            MicrophonePreference::Ask => {
                self.voice_notice = Some("CHECKING MICROPHONES".to_string());
                self.begin_microphone_enumeration(
                    MicrophoneDeviceOperation::Activation { legacy_name: None },
                    window,
                    cx,
                );
                true
            }
            MicrophonePreference::SystemDefault => {
                self.begin_dictation(
                    preference_start(&MicrophonePreference::SystemDefault)
                        .expect("system default always has a start selector"),
                    window,
                    cx,
                );
                true
            }
            MicrophonePreference::Device { id: Some(_), .. } => {
                if let Some(selection) = preference_start(&self.microphone_preference) {
                    self.begin_dictation(selection, window, cx);
                    true
                } else {
                    false
                }
            }
            MicrophonePreference::Device { id: None, name } => {
                self.voice_notice = Some("CHECKING SAVED MICROPHONE".to_string());
                self.begin_microphone_enumeration(
                    MicrophoneDeviceOperation::Activation {
                        legacy_name: Some(name.clone()),
                    },
                    window,
                    cx,
                );
                true
            }
        }
    }

    fn begin_dictation(
        &mut self,
        selection: VoiceStartSelection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.voice_draft.is_some() {
            return;
        }

        let value = self.input.read(cx).value().to_string();
        let cursor = self.input.read(cx).cursor().min(value.len());
        let cursor = value.floor_char_boundary(cursor);
        let request_id = self.next_voice_request_id;
        self.next_voice_request_id = self.next_voice_request_id.wrapping_add(1).max(1);
        self.voice_draft = Some(VoiceDraft::new(
            request_id,
            value[..cursor].to_string(),
            value[cursor..].to_string(),
            value.clone(),
        ));
        self.voice_notice = Some("PREPARING VOICE INPUT".to_string());
        if !value.is_empty() {
            self.reveal_voice_draft_if_needed(&value, window, cx);
            self.interaction.on_input(value);
            self.input.focus_handle(cx).focus(window);
        }
        if self
            .voice_commands
            .send(VoiceCommand::Start {
                request_id,
                locale: "auto".to_string(),
                device: selection.device,
                device_id: selection.device_id,
                exact_device: selection.exact_device,
            })
            .is_err()
        {
            self.voice_draft = None;
            self.voice_notice = Some("VOICE INPUT UNAVAILABLE · KEEP TYPING".to_string());
            self.reassert_vision_context();
        } else {
            self.begin_vision_for_voice(request_id);
            // The request exists, but it is not action-eligible until both
            // Listening and the initial MuteState are authoritative.
            self.reassert_vision_context();
        }
        cx.notify();
    }

    /// Requests a helper-owned microphone mute transition. The Desktop state
    /// remains at the last acknowledged value until a matching MuteState event
    /// proves that the input gate is applied or reopened. The device and
    /// capture stream deliberately remain open while samples are gated before
    /// queueing and inference.
    pub(super) fn gesture_set_dictation_muted(
        &mut self,
        muted: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(request_id) = self
            .voice_draft
            .as_ref()
            .filter(|voice| voice.can_request_mute(muted))
            .map(|voice| voice.request_id)
        else {
            return false;
        };
        if self
            .voice_commands
            .send(VoiceCommand::SetMuted { request_id, muted })
            .is_err()
        {
            // A closed command owner cannot acknowledge capture state. End
            // the action lease and release the voice session while leaving
            // the latest rendered words visible for ordinary typing.
            self.disable_vision_for_voice(request_id);
            self.voice_draft = None;
            self.reassert_vision_context();
            self.voice_notice = Some("VOICE INPUT UNAVAILABLE · KEEP TYPING".to_string());
            cx.notify();
            return false;
        }
        if let Some(voice) = self
            .voice_draft
            .as_mut()
            .filter(|voice| voice.request_id == request_id)
        {
            voice.note_mute_requested(muted);
        }
        self.voice_notice = Some(
            if muted {
                "LISTENING · MUTING MICROPHONE"
            } else {
                "LISTENING · UNMUTING MICROPHONE"
            }
            .to_string(),
        );
        cx.notify();
        true
    }

    /// Commits the current ASR segment without releasing the microphone, voice
    /// request, gesture lease, or applied mute state. The helper owns the exact
    /// audio boundary and returns one authoritative, segment-fenced result.
    pub(super) fn gesture_send_dictation_now(&mut self, cx: &mut Context<Self>) -> bool {
        let Some((request_id, segment_id)) = self
            .voice_draft
            .as_ref()
            .filter(|voice| {
                voice.can_request_segment_commit()
                    && self.voice_final_conversation_is_safe(voice, cx)
                    && self.voice_final_send_is_safe()
            })
            .map(|voice| (voice.request_id, voice.segment_id))
        else {
            return false;
        };
        if self
            .voice_commands
            .send(VoiceCommand::CommitSegment {
                request_id,
                segment_id,
            })
            .is_err()
        {
            self.disable_vision_for_voice(request_id);
            self.voice_draft = None;
            self.reassert_vision_context();
            self.voice_notice = Some("VOICE INPUT UNAVAILABLE · KEEP TYPING".to_string());
            cx.notify();
            return false;
        }
        if let Some(voice) = self
            .voice_draft
            .as_mut()
            .filter(|voice| voice.request_id == request_id && voice.segment_id == segment_id)
        {
            voice.note_segment_commit_requested();
        }
        self.voice_notice = Some("LISTENING · PREPARING TO SEND".to_string());
        cx.notify();
        true
    }

    pub(super) fn dictation_is_muted(&self) -> bool {
        self.voice_draft.as_ref().is_some_and(|voice| voice.muted)
    }

    pub(super) fn dictation_pending_mute(&self) -> Option<bool> {
        self.voice_draft
            .as_ref()
            .and_then(|voice| voice.pending_mute)
    }

    pub(super) fn dictation_segment_commit_is_pending(&self) -> bool {
        self.voice_draft
            .as_ref()
            .is_some_and(|voice| voice.pending_segment_commit.is_some())
    }

    pub(super) fn active_voice_request_id(&self) -> Option<u64> {
        self.voice_draft.as_ref().map(|voice| voice.request_id)
    }

    pub(super) fn voice_request_can_stop(&self, request_id: u64) -> bool {
        self.voice_draft
            .as_ref()
            .is_some_and(|voice| voice.request_id == request_id && !voice.stopping)
    }

    pub(super) fn voice_request_is_listening(&self, request_id: u64) -> bool {
        self.voice_draft
            .as_ref()
            .is_some_and(|voice| voice.request_id == request_id && voice.listening)
    }

    pub(super) fn voice_request_is_stopping(&self, request_id: u64) -> bool {
        self.voice_draft
            .as_ref()
            .is_some_and(|voice| voice.request_id == request_id && voice.stopping)
    }

    pub(super) fn voice_request_accepts_gestures(&self, request_id: u64) -> bool {
        self.voice_request_has_active_gesture_context(request_id)
            && self.voice_draft.as_ref().is_some_and(|voice| {
                voice.request_id == request_id
                    && voice.pending_mute.is_none()
                    && voice.pending_segment_commit.is_none()
            })
    }

    pub(super) fn voice_request_has_active_gesture_context(&self, request_id: u64) -> bool {
        self.voice_draft.as_ref().is_some_and(|voice| {
            voice.request_id == request_id
                && voice.listening
                && !voice.stopping
                && voice.mute_revision.is_some()
        })
    }

    pub(super) fn finish_dictation(&mut self, cx: &mut Context<Self>) {
        let Some(voice) = self.voice_draft.as_ref() else {
            return;
        };
        if voice.stopping {
            self.voice_notice = Some("FINISHING VOICE INPUT".to_string());
            cx.notify();
            return;
        }
        let request_id = voice.request_id;
        // Revoke the helper's request lease before asking the transcription
        // owner to finish. A queued active intent cannot race the terminal
        // path, and the request stays Disabled until its terminal event.
        self.disable_vision_for_voice(request_id);
        match self.voice_commands.send(VoiceCommand::Stop { request_id }) {
            Ok(()) => {
                if let Some(voice) = self.voice_draft.as_mut() {
                    voice.stopping = true;
                }
                self.voice_notice = Some("FINISHING VOICE INPUT".to_string());
            }
            Err(_) => {
                // A failed terminal command means the supervisor cannot own
                // this session anymore. Keep the latest visible words and
                // release the UI state so typing is never held hostage.
                self.voice_draft = None;
                self.reassert_vision_context();
                self.voice_notice = Some("VOICE INPUT UNAVAILABLE · KEEP TYPING".to_string());
            }
        }
        cx.notify();
    }

    pub(super) fn handle_voice_event(
        &mut self,
        event: VoiceEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match &event {
            VoiceEvent::Devices {
                request_id,
                devices,
            } if self
                .pending_microphone_request
                .as_ref()
                .is_some_and(|pending| pending.request_id == *request_id) =>
            {
                self.complete_microphone_enumeration(*request_id, devices.clone(), window, cx);
                return;
            }
            VoiceEvent::Error {
                request_id: Some(request_id),
                code,
            } if self
                .pending_microphone_request
                .as_ref()
                .is_some_and(|pending| pending.request_id == *request_id) =>
            {
                self.fail_microphone_enumeration(*request_id, *code, window, cx);
                return;
            }
            VoiceEvent::Cancelled { request_id }
                if self
                    .pending_microphone_request
                    .as_ref()
                    .is_some_and(|pending| pending.request_id == *request_id) =>
            {
                self.pending_microphone_request = None;
                self.microphone_request_cancellation = None;
                self.sync_vision_context();
                self.refresh_idle_vision_notice();
                return;
            }
            _ => {}
        }
        match event {
            VoiceEvent::MuteState {
                request_id,
                revision,
                muted,
            } if self.voice_request_is(request_id) => {
                let application = self
                    .voice_draft
                    .as_mut()
                    .filter(|voice| voice.request_id == request_id)
                    .map_or(MuteStateApplication::Ignored, |voice| {
                        voice.apply_mute_state(revision, muted)
                    });
                match application {
                    MuteStateApplication::Ignored => {}
                    MuteStateApplication::Applied => {
                        self.clear_voice_gesture_status();
                        self.enable_vision_for_voice(request_id);
                        self.sync_vision_context();
                        self.refresh_listening_voice_notice();
                        cx.notify();
                    }
                    MuteStateApplication::Contradicted => {
                        self.voice_draft = None;
                        self.disable_vision_for_voice(request_id);
                        let _ = self
                            .voice_commands
                            .send(VoiceCommand::Cancel { request_id });
                        self.voice_notice = Some("VOICE INPUT STOPPED · KEEP TYPING".to_string());
                        cx.notify();
                    }
                }
            }
            VoiceEvent::State {
                request_id,
                phase,
                progress,
            } if self.voice_request_is(request_id) => {
                if phase == VoicePhase::Listening {
                    if let Some(voice) = self.voice_draft.as_mut() {
                        voice.listening = true;
                    }
                    self.enable_vision_for_voice(request_id);
                } else if phase == VoicePhase::Finishing {
                    if let Some(voice) = self.voice_draft.as_mut() {
                        voice.listening = false;
                    }
                    self.disable_vision_for_voice(request_id);
                }
                let voice = self
                    .voice_draft
                    .as_ref()
                    .filter(|voice| voice.request_id == request_id);
                if voice.is_some_and(|voice| voice.stopping) {
                    self.voice_notice = Some("FINISHING VOICE INPUT".to_string());
                } else if phase == VoicePhase::Listening {
                    self.voice_notice = Some(self.listening_voice_notice(request_id).to_string());
                } else {
                    self.voice_notice = Some(voice_phase_notice(phase, progress));
                }
            }
            VoiceEvent::Partial {
                request_id,
                segment_id,
                revision,
                committed,
                tentative,
            } if self.voice_request_is(request_id) => {
                let conflicts_with_visible_draft = self.voice_draft.as_ref().is_some_and(|voice| {
                    voice.accepts_segment(segment_id)
                        && self.input.read(cx).value().as_ref() != voice.rendered
                });
                if conflicts_with_visible_draft {
                    // An asynchronous failure may have restored the segment
                    // that was just sent. Never let a later programmatic
                    // partial overwrite that recovery.
                    self.fail_continuous_dictation(request_id, cx);
                    return;
                }
                // Listening snapshots are intentionally coalescible under UI
                // backpressure. A matching partial is equally authoritative
                // evidence that this request owns the live microphone.
                if let Some(voice) = self.voice_draft.as_mut() {
                    voice.listening = true;
                }
                self.enable_vision_for_voice(request_id);
                let Some(voice) = self.voice_draft.as_mut() else {
                    return;
                };
                if !voice.accepts_segment(segment_id) || revision <= voice.revision {
                    return;
                }
                voice.revision = revision;
                let transcript = format!("{committed}{tentative}");
                let composition = compose_voice_text(&voice.before, &transcript, &voice.after);
                let stopping = voice.stopping;
                let sending = voice.pending_segment_commit.is_some();
                voice.rendered.clone_from(&composition.value);
                self.reveal_voice_draft_if_needed(&composition.value, window, cx);
                self.interaction.on_input(composition.value.clone());
                self.set_input_value_at(composition.value, composition.cursor, window, cx);
                self.voice_notice = Some(if stopping {
                    "FINISHING VOICE INPUT".to_string()
                } else if sending {
                    "LISTENING · PREPARING TO SEND".to_string()
                } else {
                    self.listening_voice_notice(request_id).to_string()
                });
            }
            VoiceEvent::SegmentFinal {
                request_id,
                segment_id,
                text,
            } if self.voice_request_is(request_id) => {
                let safe = self
                    .voice_draft
                    .as_ref()
                    .filter(|voice| voice.awaits_segment_final(segment_id))
                    .is_some_and(|voice| {
                        self.voice_final_conversation_is_safe(voice, cx)
                            && self.voice_final_send_is_safe()
                    });
                if !safe {
                    let matching = self
                        .voice_draft
                        .as_ref()
                        .is_some_and(|voice| voice.awaits_segment_final(segment_id));
                    if matching {
                        self.fail_continuous_dictation(request_id, cx);
                    }
                    return;
                }

                let Some(voice) = self
                    .voice_draft
                    .as_ref()
                    .filter(|voice| voice.awaits_segment_final(segment_id))
                else {
                    return;
                };
                let composition = compose_voice_text(&voice.before, &text, &voice.after);
                self.reveal_voice_draft_if_needed(&composition.value, window, cx);
                self.interaction.on_input(composition.value.clone());
                self.set_input_value_at(composition.value.clone(), composition.cursor, window, cx);

                let should_submit =
                    !composition.value.trim().is_empty() || !self.draft_attachments.is_empty();
                if should_submit {
                    self.submit_conversation(composition.value, window, cx);
                    if !self.interaction.is_submitting() {
                        // The ordinary submission owner restored the exact
                        // authoritative segment after a synchronous failure.
                        // Preserve it and fence future voice output.
                        self.fail_continuous_dictation(request_id, cx);
                        return;
                    }
                }

                // Submission success clears the input, while a synchronous
                // delivery failure restores it. Rebase from that authoritative
                // post-submit value so the next segment preserves either case.
                let value = self.input.read(cx).value().to_string();
                let cursor = self.input.read(cx).cursor().min(value.len());
                let cursor = value.floor_char_boundary(cursor);
                if let Some(voice) = self.voice_draft.as_mut().filter(|voice| {
                    voice.request_id == request_id && voice.awaits_segment_final(segment_id)
                }) {
                    voice.begin_next_segment(value, cursor);
                }
                self.clear_voice_gesture_status();
                self.enable_vision_for_voice(request_id);
                // SegmentFinal is the helper-owned completion edge for Send.
                // Request and mute context are intentionally unchanged, so
                // force an authority frame instead of replace-if-changed sync.
                self.reassert_vision_context();
                self.voice_notice = Some(self.listening_voice_notice(request_id).to_string());
                cx.notify();
            }
            VoiceEvent::Final { request_id, text } if self.voice_request_is(request_id) => {
                let Some(voice) = self.voice_draft.take() else {
                    return;
                };
                self.disable_vision_for_voice(request_id);
                if text.trim().is_empty() {
                    if voice.revision < 0 {
                        self.voice_notice = Some("NO SPEECH HEARD · CHECK INPUT".to_string());
                    } else {
                        self.voice_notice = None;
                        self.refresh_idle_vision_notice();
                    }
                    return;
                }
                if !self.voice_final_conversation_is_safe(&voice, cx) {
                    self.voice_notice = None;
                    return;
                }
                let composition = compose_voice_text(&voice.before, &text, &voice.after);
                self.reveal_voice_draft_if_needed(&composition.value, window, cx);
                self.interaction.on_input(composition.value.clone());
                self.set_input_value_at(composition.value.clone(), composition.cursor, window, cx);
                self.voice_notice = None;
                self.refresh_idle_vision_notice();
            }
            VoiceEvent::Cancelled { request_id } if self.voice_request_is(request_id) => {
                self.voice_draft = None;
                self.disable_vision_for_voice(request_id);
                self.voice_notice = None;
                self.refresh_idle_vision_notice();
            }
            VoiceEvent::Error { request_id, code }
                if request_id.is_none_or(|request_id| self.voice_request_is(request_id)) =>
            {
                let active_request_id = self.active_voice_request_id();
                self.voice_draft = None;
                if let Some(request_id) = active_request_id {
                    self.disable_vision_for_voice(request_id);
                } else {
                    self.sync_vision_context();
                }
                self.voice_notice = Some(voice_error_notice(code).to_string());
                if matches!(
                    code,
                    VoiceErrorCode::MicrophoneUnavailable | VoiceErrorCode::MicrophoneSilent
                ) {
                    let override_notice = match environment_voice_device() {
                        Ok(Some(name)) => Some(format!(
                            "GSV_VOICE_DEVICE IS UNAVAILABLE · {name} · SAVED CHOICES APPLY LATER"
                        )),
                        Err(()) => Some(
                            "GSV_VOICE_DEVICE IS INVALID · SAVED CHOICES APPLY AFTER REMOVAL"
                                .to_string(),
                        ),
                        Ok(None) => Some(voice_error_notice(code).to_string()),
                    };
                    let start_after = matches!(environment_voice_device(), Ok(None));
                    self.open_microphone_chooser(start_after, override_notice, window, cx);
                }
            }
            _ => {}
        }
    }

    fn voice_request_is(&self, request_id: u64) -> bool {
        self.voice_draft
            .as_ref()
            .is_some_and(|voice| voice.request_id == request_id)
    }

    fn fail_continuous_dictation(&mut self, request_id: u64, cx: &mut Context<Self>) {
        if !self.voice_request_is(request_id) {
            return;
        }
        self.voice_draft = None;
        self.disable_vision_for_voice(request_id);
        let _ = self
            .voice_commands
            .send(VoiceCommand::Cancel { request_id });
        self.voice_notice = Some("VOICE INPUT STOPPED · KEEP TYPING".to_string());
        cx.notify();
    }

    /// Fences a continuing voice request when ordinary submission recovery
    /// restores an older segment into the input. If a newer dictated draft is
    /// already present, the interaction owner preserves it and the values
    /// still match, so dictation can continue.
    pub(super) fn reconcile_dictation_after_submission_failure(&mut self, cx: &mut Context<Self>) {
        let Some(request_id) = self.voice_draft.as_ref().and_then(|voice| {
            (self.input.read(cx).value().as_ref() != voice.rendered).then_some(voice.request_id)
        }) else {
            return;
        };
        self.fail_continuous_dictation(request_id, cx);
    }

    fn voice_final_conversation_is_safe(&self, voice: &VoiceDraft, cx: &Context<Self>) -> bool {
        self.login.is_none()
            && !self.desktop_switch_pending
            && self.microphone_chooser.is_none()
            && self.conversation.mode == SurfaceMode::Conversation
            && !self.interaction.is_approval()
            && !self.interaction.is_approval_submitting()
            && !self.interaction.is_submitting()
            && self.input.read(cx).value().as_ref() == voice.rendered
    }

    fn voice_final_send_is_safe(&self) -> bool {
        self.login.is_none()
            && !self.desktop_switch_pending
            && self.microphone_chooser.is_none()
            && self.conversation.mode == SurfaceMode::Conversation
            && self.interaction.layer == super::CanvasLayer::Draft
            && !self.interaction.is_approval()
            && !self.interaction.is_approval_submitting()
            && !self.interaction.is_submitting()
    }

    pub(super) fn cancel_dictation(
        &mut self,
        restore_base: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(voice) = self.voice_draft.take() else {
            return;
        };
        self.disable_vision_for_voice(voice.request_id);
        let command_failed = self
            .voice_commands
            .send(VoiceCommand::Cancel {
                request_id: voice.request_id,
            })
            .is_err();
        if restore_base && self.input.read(cx).value().as_ref() == voice.rendered {
            let cursor = voice.before.len();
            let value = format!("{}{}", voice.before, voice.after);
            self.interaction.on_input(value.clone());
            self.set_input_value_at(value, cursor, window, cx);
        }
        self.voice_notice =
            command_failed.then(|| "VOICE INPUT UNAVAILABLE · KEEP TYPING".to_string());
        if !command_failed {
            self.refresh_idle_vision_notice();
        }
    }
}

fn voice_phase_notice(phase: VoicePhase, progress: Option<f32>) -> String {
    match phase {
        VoicePhase::Downloading => progress.map_or_else(
            || "DOWNLOADING VOICE INPUT".to_string(),
            |progress| format!("DOWNLOADING VOICE INPUT · {:.0}%", progress * 100.0),
        ),
        VoicePhase::Verifying => "VERIFYING VOICE INPUT".to_string(),
        VoicePhase::Loading => "PREPARING VOICE INPUT".to_string(),
        VoicePhase::Listening => "LISTENING · SPEAK NOW · PRESS AGAIN TO FINISH".to_string(),
        VoicePhase::Finishing => "FINISHING VOICE INPUT".to_string(),
    }
}

fn voice_error_notice(code: VoiceErrorCode) -> &'static str {
    match code {
        VoiceErrorCode::MicrophoneUnavailable => "MICROPHONE UNAVAILABLE · CHECK ACCESS",
        VoiceErrorCode::MicrophoneSilent => "NO MICROPHONE AUDIO · CHECK INPUT",
        VoiceErrorCode::AudioOverflow => "VOICE INPUT COULDN'T KEEP UP · TRY AGAIN",
        VoiceErrorCode::NotInstalled => "VOICE INPUT ISN'T INSTALLED · KEEP TYPING",
        VoiceErrorCode::HelperUnavailable => "VOICE INPUT COULDN'T START · KEEP TYPING",
        VoiceErrorCode::DownloadFailed | VoiceErrorCode::ModelInvalid => {
            "VOICE INPUT COULDN'T PREPARE · CHECK CONNECTION"
        }
        VoiceErrorCode::Busy => "VOICE INPUT IS BUSY · TRY AGAIN",
        VoiceErrorCode::NotActive => "VOICE INPUT ALREADY STOPPED · KEEP TYPING",
        VoiceErrorCode::Interrupted => "VOICE INPUT WAS INTERRUPTED · KEEP TYPING",
        VoiceErrorCode::EngineFailed | VoiceErrorCode::InvalidCommand => {
            "VOICE INPUT STOPPED · KEEP TYPING"
        }
    }
}

pub(super) fn configured_microphone_preference() -> MicrophonePreference {
    match CliConfig::load().desktop.microphone_preference() {
        MicrophonePreference::Device { id, name } => {
            let Some(name) = crate::transcription::normalized_device_name(&name) else {
                return MicrophonePreference::Ask;
            };
            let id = match id {
                Some(id) => {
                    let Some(id) = crate::transcription::normalized_device_id(&id) else {
                        return MicrophonePreference::Ask;
                    };
                    Some(id)
                }
                None => None,
            };
            MicrophonePreference::Device { id, name }
        }
        preference => preference,
    }
}

fn environment_voice_device() -> Result<Option<String>, ()> {
    let Some(value) = std::env::var_os("GSV_VOICE_DEVICE") else {
        return Ok(None);
    };
    let value = value.to_str().ok_or(())?;
    crate::transcription::normalized_device_name(value)
        .map(Some)
        .ok_or(())
}

fn preference_start(preference: &MicrophonePreference) -> Option<VoiceStartSelection> {
    match preference {
        MicrophonePreference::Ask | MicrophonePreference::Device { id: None, .. } => None,
        MicrophonePreference::SystemDefault => Some(VoiceStartSelection {
            device: None,
            device_id: None,
            exact_device: true,
        }),
        MicrophonePreference::Device { id: Some(id), name } => Some(VoiceStartSelection {
            device: Some(name.clone()),
            device_id: Some(id.clone()),
            exact_device: true,
        }),
    }
}

fn microphone_status_devices(
    devices: &[crate::transcription::VoiceDevice],
) -> Result<Vec<MicrophoneDevice>, OperationError> {
    devices
        .iter()
        .map(|device| {
            Ok(MicrophoneDevice {
                name: MicrophoneName::new(device.name.clone())
                    .map_err(|_| OperationError::Internal)?,
                is_default: device.is_default,
            })
        })
        .collect::<Result<Vec<_>, OperationError>>()
}

fn preferred_microphone_index(
    devices: &[crate::transcription::VoiceDevice],
    preference: &MicrophonePreference,
) -> usize {
    if let Ok(Some(override_name)) = environment_voice_device() {
        if let Some(index) = legacy_microphone_name_index(devices, &override_name) {
            return index + 1;
        }
    }
    match preference {
        MicrophonePreference::Device { id: Some(id), .. } => devices
            .iter()
            .position(|device| device.id == *id)
            .map_or(0, |index| index + 1),
        MicrophonePreference::Device { id: None, name } => devices
            .iter()
            .position(|device| device.name == *name)
            .map_or(0, |index| index + 1),
        MicrophonePreference::Ask | MicrophonePreference::SystemDefault => 0,
    }
}

fn legacy_microphone_name_index(
    devices: &[crate::transcription::VoiceDevice],
    preferred: &str,
) -> Option<usize> {
    let preferred = preferred.to_lowercase();
    if let Some(index) = devices
        .iter()
        .position(|device| device.name.to_lowercase() == preferred)
    {
        return Some(index);
    }
    let partials = devices
        .iter()
        .enumerate()
        .filter(|(_, device)| device.name.to_lowercase().contains(&preferred))
        .collect::<Vec<_>>();
    let first_name = partials.first()?.1.name.to_lowercase();
    partials
        .iter()
        .all(|(_, device)| device.name.to_lowercase() == first_name)
        .then_some(partials[0].0)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gpui::{TestAppContext, WindowOptions};
    use gpui_component::Root;

    use crate::app::bind_keys;
    use crate::client::ClientCommand;

    use super::*;

    #[test]
    fn voice_errors_are_actionable_without_exposing_internal_details() {
        assert_eq!(
            voice_error_notice(VoiceErrorCode::MicrophoneUnavailable),
            "MICROPHONE UNAVAILABLE · CHECK ACCESS"
        );
        assert_eq!(
            voice_error_notice(VoiceErrorCode::NotInstalled),
            "VOICE INPUT ISN'T INSTALLED · KEEP TYPING"
        );
        assert_eq!(
            voice_error_notice(VoiceErrorCode::HelperUnavailable),
            "VOICE INPUT COULDN'T START · KEEP TYPING"
        );
        assert_eq!(
            voice_error_notice(VoiceErrorCode::DownloadFailed),
            "VOICE INPUT COULDN'T PREPARE · CHECK CONNECTION"
        );
        assert_eq!(
            voice_error_notice(VoiceErrorCode::EngineFailed),
            "VOICE INPUT STOPPED · KEEP TYPING"
        );
        assert_eq!(
            voice_error_notice(VoiceErrorCode::MicrophoneSilent),
            "NO MICROPHONE AUDIO · CHECK INPUT"
        );
        assert_eq!(
            voice_error_notice(VoiceErrorCode::AudioOverflow),
            "VOICE INPUT COULDN'T KEEP UP · TRY AGAIN"
        );
    }

    #[test]
    fn voice_phases_expose_progress_without_model_details() {
        assert_eq!(
            voice_phase_notice(VoicePhase::Downloading, Some(0.42)),
            "DOWNLOADING VOICE INPUT · 42%"
        );
        assert_eq!(
            voice_phase_notice(VoicePhase::Verifying, None),
            "VERIFYING VOICE INPUT"
        );
        assert_eq!(
            voice_phase_notice(VoicePhase::Listening, None),
            "LISTENING · SPEAK NOW · PRESS AGAIN TO FINISH"
        );
    }

    #[test]
    fn session_actions_need_no_redundant_arm_bit() {
        let mut voice = VoiceDraft::new(7, String::new(), String::new(), String::new());

        assert!(voice.can_request_segment_commit());
        assert_eq!(
            voice.apply_mute_state(0, true),
            MuteStateApplication::Applied
        );
        assert!(voice.can_request_segment_commit());
        voice.note_segment_commit_requested();
        assert!(!voice.can_request_segment_commit());
        assert!(voice.awaits_segment_final(0));
        voice.begin_next_segment(String::new(), 0);
        assert_eq!(voice.segment_id, 1);
        assert!(voice.can_request_segment_commit());
        assert!(voice.muted);
    }

    #[test]
    fn stopping_voice_rejects_session_actions() {
        let mut voice = VoiceDraft::new(7, String::new(), String::new(), String::new());
        voice.stopping = true;

        assert!(!voice.can_request_segment_commit());
        assert!(!voice.can_request_mute(true));
    }

    #[test]
    fn mute_state_changes_only_on_new_ack() {
        let mut voice = VoiceDraft::new(7, String::new(), String::new(), String::new());
        assert_eq!(
            voice.apply_mute_state(0, false),
            MuteStateApplication::Applied
        );
        assert!(voice.can_request_mute(true));
        voice.note_mute_requested(true);
        assert_eq!(voice.pending_mute, Some(true));
        assert!(!voice.muted);

        assert_eq!(
            voice.apply_mute_state(1, true),
            MuteStateApplication::Applied
        );
        assert_eq!(voice.pending_mute, None);
        assert!(voice.muted);
        assert_eq!(
            voice.apply_mute_state(1, false),
            MuteStateApplication::Ignored
        );
        assert!(voice.muted);

        assert!(voice.can_request_mute(false));
        voice.note_mute_requested(false);
        assert_eq!(
            voice.apply_mute_state(2, true),
            MuteStateApplication::Contradicted
        );
        assert_eq!(voice.pending_mute, None);

        assert!(voice.muted);
    }

    #[test]
    fn named_preference_starts_with_exact_matching() {
        assert_eq!(
            preference_start(&MicrophonePreference::Device {
                id: Some("opaque-usb-id".to_string()),
                name: "USB microphone".to_string(),
            }),
            Some(VoiceStartSelection {
                device: Some("USB microphone".to_string()),
                device_id: Some("opaque-usb-id".to_string()),
                exact_device: true,
            })
        );
        assert_eq!(
            preference_start(&MicrophonePreference::SystemDefault),
            Some(VoiceStartSelection {
                device: None,
                device_id: None,
                exact_device: true,
            })
        );
        assert_eq!(
            preference_start(&MicrophonePreference::Device {
                id: None,
                name: "legacy microphone".to_string(),
            }),
            None
        );
    }

    #[test]
    fn legacy_microphone_name_resolution_is_exact_first_and_unambiguous() {
        let devices = |names: &[&str]| {
            names
                .iter()
                .enumerate()
                .map(|(index, name)| crate::transcription::VoiceDevice {
                    id: format!("device-{index}"),
                    name: (*name).to_string(),
                    is_default: false,
                })
                .collect::<Vec<_>>()
        };

        let exact = devices(&["Monitor of Shure MV6", "Shure MV6"]);
        assert_eq!(legacy_microphone_name_index(&exact, "shure mv6"), Some(1));
        let unique = devices(&["Built-in Audio", "Shure MV6, USB Audio"]);
        assert_eq!(legacy_microphone_name_index(&unique, "shure mv6"), Some(1));
        let ambiguous = devices(&["Monitor of Shure MV6", "Shure MV6, USB Audio"]);
        assert_eq!(legacy_microphone_name_index(&ambiguous, "shure"), None);
    }

    #[test]
    fn desktop_status_preserves_duplicate_named_devices_without_exposing_ids() {
        let devices = [
            crate::transcription::VoiceDevice {
                id: "opaque-device-a".to_string(),
                name: "USB microphone".to_string(),
                is_default: true,
            },
            crate::transcription::VoiceDevice {
                id: "opaque-device-b".to_string(),
                name: "USB microphone".to_string(),
                is_default: false,
            },
        ];

        let status = microphone_status_devices(&devices).expect("valid public status");

        assert_eq!(status.len(), 2);
        assert_eq!(status[0].name.as_str(), "USB microphone");
        assert!(status[0].is_default);
        assert_eq!(status[1].name.as_str(), "USB microphone");
        assert!(!status[1].is_default);
    }

    #[gpui::test]
    fn failed_segment_commit_keeps_the_real_voice_error(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, _command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "draft partial");
        cx.run_until_parked();
        let app = app.borrow().clone().expect("app entity should be retained");
        let window_handle: gpui::AnyWindowHandle = window.into();
        window_handle
            .update(cx, |_, _, cx| {
                app.update(cx, |app, cx| {
                    app.voice_commands =
                        crate::transcription::VoiceCommandSender::closed_for_test();
                    let mut voice = VoiceDraft::new(
                        40,
                        String::new(),
                        String::new(),
                        "draft partial".to_string(),
                    );
                    voice.listening = true;
                    assert_eq!(
                        voice.apply_mute_state(0, false),
                        MuteStateApplication::Applied
                    );
                    app.voice_draft = Some(voice);
                    assert!(!app.gesture_send_dictation_now(cx));
                    assert!(app.voice_draft.is_none());
                    assert_eq!(
                        app.voice_notice.as_deref(),
                        Some("VOICE INPUT UNAVAILABLE · KEEP TYPING")
                    );
                });
            })
            .expect("window remains open");
    }

    #[gpui::test]
    fn disconnected_mute_commands_end_the_voice_lease_without_changing_input(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, _command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        let app = app.borrow().clone().expect("app entity should be retained");
        let window_handle: gpui::AnyWindowHandle = window.into();
        window_handle
            .update(cx, |_, _, cx| {
                app.update(cx, |app, cx| {
                    app.voice_commands =
                        crate::transcription::VoiceCommandSender::closed_for_test();
                    app.vision_context = Some(crate::vision_debug::VisionContextSender::for_test());
                    app.vision_lifecycle = Some(gesture_protocol::LifecycleState::Ready);

                    for (request_id, requested_muted, applied_muted) in
                        [(50, true, false), (51, false, true)]
                    {
                        let mut voice = VoiceDraft::new(
                            request_id,
                            String::new(),
                            String::new(),
                            String::new(),
                        );
                        assert_eq!(
                            voice.apply_mute_state(0, applied_muted),
                            MuteStateApplication::Applied
                        );
                        app.voice_draft = Some(voice);
                        app.vision_voice_request_id = Some(request_id);

                        assert!(!app.gesture_set_dictation_muted(requested_muted, cx));
                        assert!(app.voice_draft.is_none());
                        assert!(app.vision_voice_request_id.is_none());
                        assert_eq!(app.input.read(cx).value().as_ref(), "");
                        assert_eq!(
                            app.voice_notice.as_deref(),
                            Some("VOICE INPUT UNAVAILABLE · KEEP TYPING")
                        );
                    }
                });
            })
            .expect("window remains open");
    }

    #[gpui::test]
    fn mute_commands_change_applied_state_only_after_matching_helper_ack(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, _command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        let app = app.borrow().clone().expect("app entity should be retained");
        let window_handle: gpui::AnyWindowHandle = window.into();
        window_handle
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    let (commands, command_rx) =
                        crate::transcription::VoiceCommandSender::channel_for_test();
                    app.voice_commands = commands;
                    app.vision_context = Some(crate::vision_debug::VisionContextSender::for_test());
                    app.vision_lifecycle = Some(gesture_protocol::LifecycleState::Ready);
                    app.vision_voice_request_id = Some(60);
                    let mut voice =
                        VoiceDraft::new(60, String::new(), String::new(), String::new());
                    voice.listening = true;
                    assert_eq!(
                        voice.apply_mute_state(0, false),
                        MuteStateApplication::Applied
                    );
                    app.voice_draft = Some(voice);

                    assert!(app.gesture_set_dictation_muted(true, cx));
                    assert_eq!(
                        command_rx.try_recv(),
                        Ok(VoiceCommand::SetMuted {
                            request_id: 60,
                            muted: true,
                        })
                    );
                    assert!(!app.dictation_is_muted());
                    assert_eq!(app.dictation_pending_mute(), Some(true));
                    assert_eq!(
                        app.voice_notice.as_deref(),
                        Some("LISTENING · MUTING MICROPHONE")
                    );
                    let muted_context_revision = app
                        .vision_context
                        .as_ref()
                        .expect("test context")
                        .revision_for_test();

                    app.handle_voice_event(
                        VoiceEvent::MuteState {
                            request_id: 60,
                            revision: 1,
                            muted: true,
                        },
                        window,
                        cx,
                    );
                    assert!(app.dictation_is_muted());
                    assert_eq!(app.dictation_pending_mute(), None);
                    assert_eq!(
                        app.voice_notice.as_deref(),
                        Some("LISTENING · MICROPHONE MUTED")
                    );
                    assert!(
                        app.vision_context
                            .as_ref()
                            .expect("test context")
                            .revision_for_test()
                            > muted_context_revision
                    );

                    app.handle_vision_event(
                        crate::vision_debug::VisionEvent::Intent {
                            sequence: 1,
                            received_at: Instant::now(),
                            intent: gesture_protocol::GestureIntent::VoiceRequest {
                                voice_request_id: 60,
                                action: gesture_protocol::VoiceRequestGestureIntent::Unmute,
                            },
                        },
                        window,
                        cx,
                    );
                    assert_eq!(
                        command_rx.try_recv(),
                        Ok(VoiceCommand::SetMuted {
                            request_id: 60,
                            muted: false,
                        })
                    );
                    assert!(app.dictation_is_muted());
                    assert_eq!(app.dictation_pending_mute(), Some(false));

                    app.handle_voice_event(
                        VoiceEvent::MuteState {
                            request_id: 60,
                            revision: 2,
                            muted: false,
                        },
                        window,
                        cx,
                    );
                    assert!(!app.dictation_is_muted());
                    assert_eq!(app.dictation_pending_mute(), None);
                    assert_eq!(
                        app.voice_notice.as_deref(),
                        Some("LISTENING · GESTURES ACTIVE")
                    );

                    app.handle_voice_event(
                        VoiceEvent::MuteState {
                            request_id: 60,
                            revision: 1,
                            muted: true,
                        },
                        window,
                        cx,
                    );
                    assert!(!app.dictation_is_muted());

                    assert!(app.gesture_set_dictation_muted(true, cx));
                    assert_eq!(
                        command_rx.try_recv(),
                        Ok(VoiceCommand::SetMuted {
                            request_id: 60,
                            muted: true,
                        })
                    );
                    app.handle_voice_event(
                        VoiceEvent::MuteState {
                            request_id: 60,
                            revision: 3,
                            muted: false,
                        },
                        window,
                        cx,
                    );
                    assert!(app.voice_draft.is_none());
                    assert!(app.vision_voice_request_id.is_none());
                    assert_eq!(
                        command_rx.try_recv(),
                        Ok(VoiceCommand::Cancel { request_id: 60 })
                    );
                    assert_eq!(
                        app.voice_notice.as_deref(),
                        Some("VOICE INPUT STOPPED · KEEP TYPING")
                    );
                });
            })
            .expect("window remains open");
    }

    #[gpui::test]
    fn matching_segment_final_submits_and_keeps_the_voice_lease(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "draft partial");
        cx.run_until_parked();
        let app = app.borrow().clone().expect("app entity should be retained");
        let window_handle: gpui::AnyWindowHandle = window.into();
        let (voice_commands, voice_command_rx) =
            crate::transcription::VoiceCommandSender::channel_for_test();
        window_handle
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.voice_commands = voice_commands;
                    app.vision_context = Some(crate::vision_debug::VisionContextSender::for_test());
                    app.vision_lifecycle = Some(gesture_protocol::LifecycleState::Ready);
                    app.vision_voice_request_id = Some(41);
                    let mut voice = VoiceDraft::new(
                        41,
                        String::new(),
                        String::new(),
                        "draft partial".to_string(),
                    );
                    voice.revision = 1;
                    voice.listening = true;
                    assert_eq!(
                        voice.apply_mute_state(0, false),
                        MuteStateApplication::Applied
                    );
                    app.voice_draft = Some(voice);
                    app.sync_vision_context();
                    let context_revision = app
                        .vision_context
                        .as_ref()
                        .expect("test context")
                        .revision_for_test();
                    app.handle_vision_event(
                        crate::vision_debug::VisionEvent::Intent {
                            sequence: 1,
                            received_at: Instant::now(),
                            intent: gesture_protocol::GestureIntent::VoiceRequest {
                                voice_request_id: 41,
                                action: gesture_protocol::VoiceRequestGestureIntent::Send,
                            },
                        },
                        window,
                        cx,
                    );
                    assert!(app.dictation_segment_commit_is_pending());
                    assert!(!app.voice_request_accepts_gestures(41));
                    assert_eq!(
                        app.vision_context
                            .as_ref()
                            .expect("test context")
                            .revision_for_test(),
                        context_revision,
                        "Send waits for SegmentFinal before acknowledging vision authority"
                    );
                    app.handle_vision_event(
                        crate::vision_debug::VisionEvent::Intent {
                            sequence: 2,
                            received_at: Instant::now(),
                            intent: gesture_protocol::GestureIntent::VoiceRequest {
                                voice_request_id: 41,
                                action: gesture_protocol::VoiceRequestGestureIntent::Send,
                            },
                        },
                        window,
                        cx,
                    );
                    assert!(app.dictation_segment_commit_is_pending());
                });
            })
            .expect("window remains open");

        assert_eq!(
            voice_command_rx.try_recv(),
            Ok(VoiceCommand::CommitSegment {
                request_id: 41,
                segment_id: 0,
            })
        );
        assert!(voice_command_rx.try_recv().is_err());

        window_handle
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    let context_revision = app
                        .vision_context
                        .as_ref()
                        .expect("test context")
                        .revision_for_test();
                    app.handle_voice_event(
                        VoiceEvent::Partial {
                            request_id: 41,
                            segment_id: 1,
                            revision: 99,
                            committed: "future segment".to_string(),
                            tentative: String::new(),
                        },
                        window,
                        cx,
                    );
                    app.handle_voice_event(
                        VoiceEvent::SegmentFinal {
                            request_id: 41,
                            segment_id: 1,
                            text: "wrong segment".to_string(),
                        },
                        window,
                        cx,
                    );
                    assert!(app.dictation_segment_commit_is_pending());
                    assert_eq!(app.input.read(cx).value().as_ref(), "draft partial");
                    assert_eq!(
                        app.vision_context
                            .as_ref()
                            .expect("test context")
                            .revision_for_test(),
                        context_revision
                    );
                    app.handle_voice_event(
                        VoiceEvent::SegmentFinal {
                            request_id: 41,
                            segment_id: 0,
                            text: "authoritative final".to_string(),
                        },
                        window,
                        cx,
                    );
                    assert!(
                        app.vision_context
                            .as_ref()
                            .expect("test context")
                            .revision_for_test()
                            > context_revision,
                        "matching SegmentFinal force-acknowledges unchanged vision state"
                    );
                });
            })
            .expect("window remains open");

        assert!(matches!(
            command_rx.try_recv(),
            Ok(ClientCommand::Send { message, .. }) if message == "authoritative final"
        ));
        assert!(command_rx.try_recv().is_err());
        cx.update(|cx| {
            let app = app.read(cx);
            let voice = app
                .voice_draft
                .as_ref()
                .expect("voice lease remains active");
            assert_eq!(voice.request_id, 41);
            assert_eq!(voice.segment_id, 1);
            assert_eq!(voice.pending_segment_commit, None);
            assert_eq!(voice.revision, -1);
            assert!(voice.listening);
            assert!(!voice.muted);
            assert!(!voice.stopping);
            assert!(app.interaction.is_submitting());
            assert!(app.input.read(cx).value().is_empty());
        });

        window_handle
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.handle_voice_event(
                        VoiceEvent::Partial {
                            request_id: 41,
                            segment_id: 1,
                            revision: 1,
                            committed: "next thought".to_string(),
                            tentative: String::new(),
                        },
                        window,
                        cx,
                    );
                });
            })
            .expect("window remains open");
        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.input.read(cx).value().as_ref(), "next thought");
            assert_eq!(
                app.voice_draft
                    .as_ref()
                    .map(|voice| voice.rendered.as_str()),
                Some("next thought")
            );
        });
    }

    #[gpui::test]
    fn blank_or_unsafe_final_never_sends_and_preserves_the_visible_draft(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "draft stays here");
        cx.run_until_parked();
        let app = app.borrow().clone().expect("app entity should be retained");
        let window_handle: gpui::AnyWindowHandle = window.into();
        window_handle
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    let mut voice = VoiceDraft::new(
                        42,
                        String::new(),
                        String::new(),
                        "draft stays here".to_string(),
                    );
                    voice.revision = 1;
                    voice.stopping = true;
                    app.voice_draft = Some(voice);
                    app.handle_voice_event(
                        VoiceEvent::Final {
                            request_id: 42,
                            text: "   ".to_string(),
                        },
                        window,
                        cx,
                    );
                });
            })
            .expect("window remains open");

        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.input.read(cx).value().as_ref(), "draft stays here");
            assert_eq!(app.interaction.visible_draft(), Some("draft stays here"));
        });
        assert!(command_rx.try_recv().is_err());

        window_handle
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    let mut voice = VoiceDraft::new(
                        43,
                        String::new(),
                        String::new(),
                        "draft stays here".to_string(),
                    );
                    voice.revision = 2;
                    voice.stopping = true;
                    app.voice_draft = Some(voice);
                    app.conversation.mode = SurfaceMode::Terminal;
                    app.handle_voice_event(
                        VoiceEvent::Final {
                            request_id: 43,
                            text: "must not reach the shell".to_string(),
                        },
                        window,
                        cx,
                    );
                });
            })
            .expect("window remains open");

        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.input.read(cx).value().as_ref(), "draft stays here");
            assert_eq!(app.interaction.visible_draft(), Some("draft stays here"));
        });
        assert!(command_rx.try_recv().is_err());
    }

    #[gpui::test]
    fn asynchronous_segment_failure_restores_text_and_fences_continuing_voice(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "draft partial");
        cx.run_until_parked();
        let app = app.borrow().clone().expect("app entity should be retained");
        let window_handle: gpui::AnyWindowHandle = window.into();
        let (voice_commands, voice_command_rx) =
            crate::transcription::VoiceCommandSender::channel_for_test();
        window_handle
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.voice_commands = voice_commands;
                    let mut voice = VoiceDraft::new(
                        45,
                        String::new(),
                        String::new(),
                        "draft partial".to_string(),
                    );
                    voice.revision = 1;
                    voice.listening = true;
                    assert_eq!(
                        voice.apply_mute_state(0, false),
                        MuteStateApplication::Applied
                    );
                    voice.note_segment_commit_requested();
                    app.voice_draft = Some(voice);
                    app.handle_voice_event(
                        VoiceEvent::SegmentFinal {
                            request_id: 45,
                            segment_id: 0,
                            text: "authoritative final".to_string(),
                        },
                        window,
                        cx,
                    );
                });
            })
            .expect("window remains open");

        let submission_id = 1;
        assert!(matches!(
            command_rx.try_recv(),
            Ok(ClientCommand::Send {
                submission_id: 1,
                ..
            })
        ));
        cx.update(|cx| {
            let app = app.read(cx);
            assert!(app.voice_draft.is_some());
            assert!(app.interaction.is_submitting());
            assert!(app.input.read(cx).value().is_empty());
        });

        window_handle
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.handle_submission_failure(
                        submission_id,
                        "delivery failed".to_string(),
                        window,
                        cx,
                    );
                });
            })
            .expect("window remains open");

        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.input.read(cx).value().as_ref(), "authoritative final");
            assert!(app.voice_draft.is_none());
            assert_eq!(
                app.voice_notice.as_deref(),
                Some("VOICE INPUT STOPPED · KEEP TYPING")
            );
        });
        assert_eq!(
            voice_command_rx.try_recv(),
            Ok(VoiceCommand::Cancel { request_id: 45 })
        );
    }

    #[gpui::test]
    fn failed_segment_submission_restores_text_and_fences_continuing_voice(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel();
        drop(command_rx);
        let (_event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let client = crate::client::ClientHandle {
            commands: command_tx,
            events: event_rx,
            login: None,
        };
        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });

        cx.run_until_parked();
        cx.simulate_input(window.into(), "draft partial");
        cx.run_until_parked();
        let app = app.borrow().clone().expect("app entity should be retained");
        let window_handle: gpui::AnyWindowHandle = window.into();
        let (voice_commands, voice_command_rx) =
            crate::transcription::VoiceCommandSender::channel_for_test();
        window_handle
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.voice_commands = voice_commands;
                    let mut voice = VoiceDraft::new(
                        44,
                        String::new(),
                        String::new(),
                        "draft partial".to_string(),
                    );
                    voice.revision = 1;
                    voice.listening = true;
                    assert_eq!(
                        voice.apply_mute_state(0, false),
                        MuteStateApplication::Applied
                    );
                    voice.note_segment_commit_requested();
                    app.voice_draft = Some(voice);
                    app.handle_voice_event(
                        VoiceEvent::SegmentFinal {
                            request_id: 44,
                            segment_id: 0,
                            text: "authoritative final".to_string(),
                        },
                        window,
                        cx,
                    );
                });
            })
            .expect("window remains open");

        cx.update(|cx| {
            let app = app.read(cx);
            assert_eq!(app.input.read(cx).value().as_ref(), "authoritative final");
            assert_eq!(app.interaction.visible_draft(), Some("authoritative final"));
            assert!(!app.interaction.is_submitting());
            assert!(app.voice_draft.is_none());
        });
        assert_eq!(
            voice_command_rx.try_recv(),
            Ok(VoiceCommand::Cancel { request_id: 44 })
        );
    }

    #[gpui::test]
    fn escaping_microphone_chooser_preserves_the_conversation_draft(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            bind_keys(cx);
            crate::register_fonts(cx);
            crate::configure_theme(cx);
        });

        let app = Rc::new(RefCell::new(None));
        let app_for_window = app.clone();
        let client = crate::client::start(true);
        let window = cx.update(|cx| {
            cx.open_window(WindowOptions::default(), move |window, cx| {
                let view = cx.new(|cx| GsvApp::new(window, cx, client, true, false, true));
                *app_for_window.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            })
            .expect("the GPUI surface should open")
        });
        cx.run_until_parked();
        cx.simulate_input(window.into(), "draft stays here");
        let app = app.borrow().clone().expect("app entity should be retained");
        let window_handle: gpui::AnyWindowHandle = window.into();
        window_handle
            .update(cx, |_, window, cx| {
                app.update(cx, |app, cx| {
                    app.microphone_chooser = Some(MicrophoneChooser {
                        devices: vec![crate::transcription::VoiceDevice {
                            id: "opaque-usb-id".to_string(),
                            name: "USB microphone".to_string(),
                            is_default: true,
                        }],
                        highlighted: 0,
                        loading: false,
                        start_after_selection: false,
                        notice: None,
                    });
                    app.microphone_focus.focus(window);
                    cx.notify();
                });
            })
            .expect("window remains open");
        cx.run_until_parked();
        cx.simulate_keystrokes(window.into(), "escape");
        cx.run_until_parked();

        cx.update(|cx| {
            let app = app.read(cx);
            assert!(app.microphone_chooser.is_none());
            assert_eq!(app.input.read(cx).value().as_ref(), "draft stays here");
            assert_eq!(app.interaction.visible_draft(), Some("draft stays here"));
        });
    }
}
