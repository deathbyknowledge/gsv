use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use gpui::{AppContext, Context, Focusable, Window};
use gsv_config::{CliConfig, MicrophonePreference};
use gsv_desktop_control::{
    MicrophoneDevice, MicrophoneEnvironmentOverride, MicrophoneName, MicrophoneSelection,
    MicrophoneStatus, OperationError, RequestContext,
};

use crate::model::SurfaceMode;
use crate::transcription::{VoiceCommand, VoiceErrorCode, VoiceEvent, VoicePhase};

use super::{
    compose_voice_text, ChooseMicrophone, GsvApp, NextMicrophone, PreviousMicrophone,
    SelectMicrophone, ToggleDictation,
};

const MICROPHONE_SAVE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub(super) struct VoiceDraft {
    request_id: u64,
    before: String,
    after: String,
    pub(super) rendered: String,
    revision: i32,
    stopping: bool,
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
        if self.microphone_chooser.is_some()
            || self.pending_microphone_request.is_some()
            || self.microphone_save_pending
        {
            return;
        }
        if self.voice_draft.is_some() {
            self.finish_dictation(cx);
            return;
        }
        if self.login.is_some()
            || self.desktop_switch_pending
            || self.conversation.mode != SurfaceMode::Conversation
            || self.interaction.is_approval()
            || self.interaction.is_submitting()
        {
            return;
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
                return;
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
                return;
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
            }
            MicrophonePreference::SystemDefault => {
                self.begin_dictation(
                    preference_start(&MicrophonePreference::SystemDefault)
                        .expect("system default always has a start selector"),
                    window,
                    cx,
                );
            }
            MicrophonePreference::Device { id: Some(_), .. } => {
                if let Some(selection) = preference_start(&self.microphone_preference) {
                    self.begin_dictation(selection, window, cx);
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
        self.voice_draft = Some(VoiceDraft {
            request_id,
            before: value[..cursor].to_string(),
            after: value[cursor..].to_string(),
            rendered: value.clone(),
            revision: -1,
            stopping: false,
        });
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
        }
        cx.notify();
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
                return;
            }
            _ => {}
        }
        match event {
            VoiceEvent::State {
                request_id,
                phase,
                progress,
            } if self.voice_request_is(request_id) => {
                if self
                    .voice_draft
                    .as_ref()
                    .is_some_and(|voice| voice.stopping)
                {
                    self.voice_notice = Some("FINISHING VOICE INPUT".to_string());
                } else {
                    self.voice_notice = Some(voice_phase_notice(phase, progress));
                }
            }
            VoiceEvent::Partial {
                request_id,
                revision,
                committed,
                tentative,
            } if self.voice_request_is(request_id) => {
                let Some(voice) = self.voice_draft.as_mut() else {
                    return;
                };
                if revision <= voice.revision {
                    return;
                }
                voice.revision = revision;
                let transcript = format!("{committed}{tentative}");
                let composition = compose_voice_text(&voice.before, &transcript, &voice.after);
                let stopping = voice.stopping;
                voice.rendered.clone_from(&composition.value);
                self.reveal_voice_draft_if_needed(&composition.value, window, cx);
                self.interaction.on_input(composition.value.clone());
                self.set_input_value_at(composition.value, composition.cursor, window, cx);
                self.voice_notice = Some(if stopping {
                    "FINISHING VOICE INPUT".to_string()
                } else {
                    voice_phase_notice(VoicePhase::Listening, None)
                });
            }
            VoiceEvent::Final { request_id, text } if self.voice_request_is(request_id) => {
                let Some(voice) = self.voice_draft.take() else {
                    return;
                };
                if text.trim().is_empty() {
                    self.voice_notice =
                        (voice.revision < 0).then(|| "NO SPEECH HEARD · CHECK INPUT".to_string());
                    return;
                }
                let composition = compose_voice_text(&voice.before, &text, &voice.after);
                self.reveal_voice_draft_if_needed(&composition.value, window, cx);
                self.interaction.on_input(composition.value.clone());
                self.set_input_value_at(composition.value, composition.cursor, window, cx);
                self.voice_notice = None;
            }
            VoiceEvent::Cancelled { request_id } if self.voice_request_is(request_id) => {
                self.voice_draft = None;
                self.voice_notice = None;
            }
            VoiceEvent::Error { request_id, code }
                if request_id.is_none_or(|request_id| self.voice_request_is(request_id)) =>
            {
                self.voice_draft = None;
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

    pub(super) fn cancel_dictation(
        &mut self,
        restore_base: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(voice) = self.voice_draft.take() else {
            return;
        };
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
