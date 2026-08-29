mod shader;

use std::fmt;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use bytemuck::{Pod, Zeroable};
use tokio::sync::mpsc as async_mpsc;
use wgpu::util::DeviceExt;

const LOOP_SECONDS: f32 = 12.0;
const INPUT_ACTIVITY_THRESHOLD: f32 = 0.005;
const KEYBOARD_DRIVE_DECAY: f32 = 10.0;
const KEYBOARD_ATTACK: f32 = 26.0;
const KEYBOARD_RELEASE: f32 = 7.0;
const MICROPHONE_ATTACK: f32 = 14.0;
const MICROPHONE_RELEASE: f32 = 5.0;
const MICROPHONE_HOLD_SECONDS: f32 = 0.16;
const MICROPHONE_DRIVE_DECAY: f32 = 12.0;
const ACCENT: [f32; 4] = [0.702, 0.682, 1.0, 1.0];
const VIOLET: [f32; 4] = [0.561, 0.541, 1.0, 1.0];
const READING_BLUE: [f32; 4] = [0.596, 0.710, 1.0, 1.0];
const WRITING_LILAC: [f32; 4] = [0.820, 0.610, 1.0, 1.0];
const DELETING_VIOLET: [f32; 4] = [0.790, 0.460, 1.0, 1.0];
const SHREDDING_LILAC: [f32; 4] = [0.690, 0.570, 1.0, 1.0];
const SEARCHING_BLUE: [f32; 4] = [0.530, 0.760, 1.0, 1.0];
const EXECUTING_VIOLET: [f32; 4] = [0.710, 0.560, 1.0, 1.0];
const DELEGATING_VIOLET: [f32; 4] = [0.680, 0.590, 1.0, 1.0];
const BLUE: [f32; 4] = [0.561, 0.714, 1.0, 1.0];

const FULLSCREEN_VERTEX_SHADER: &str = r#"
@vertex
fn main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    return vec4<f32>(positions[vertex_index], 0.0, 1.0);
}
"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VisualPreset {
    Listening,
    Thinking,
    Reading,
    Writing,
    Deleting,
    DeletingShredder,
    Searching,
    Executing,
    Delegating,
    Speaking,
    ShipHologram,
    ShipPhysical,
    ShipArmed,
}

impl VisualPreset {
    pub const ALL: [Self; 13] = [
        Self::Listening,
        Self::Thinking,
        Self::Reading,
        Self::Writing,
        Self::Deleting,
        Self::DeletingShredder,
        Self::Searching,
        Self::Executing,
        Self::Delegating,
        Self::Speaking,
        Self::ShipHologram,
        Self::ShipPhysical,
        Self::ShipArmed,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Listening => "LISTENING",
            Self::Thinking => "THINKING",
            Self::Reading => "READING",
            Self::Writing => "WRITING",
            Self::Deleting => "DELETE // BIN",
            Self::DeletingShredder => "DELETE // SHREDDER",
            Self::Searching => "SEARCHING",
            Self::Executing => "EXECUTING",
            Self::Delegating => "DELEGATING",
            Self::Speaking => "SPEAKING",
            Self::ShipHologram => "SHIP // DISARMED",
            Self::ShipPhysical => "SHIP // PHYSICAL",
            Self::ShipArmed => "SHIP // ARMED",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct VisualEngineConfig {
    pub width: u32,
    pub height: u32,
    pub frames_per_second: u32,
    pub idle_frames_per_second: u32,
    pub initial_preset: VisualPreset,
    pub initially_active: bool,
}

impl Default for VisualEngineConfig {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 832,
            frames_per_second: 30,
            idle_frames_per_second: 30,
            initial_preset: VisualPreset::Listening,
            initially_active: true,
        }
    }
}

#[derive(Debug)]
pub struct VisualFrame {
    pub width: u32,
    pub height: u32,
    pub sequence: u64,
    pub render_time: Duration,
    pub bgra: Vec<u8>,
}

#[derive(Debug)]
pub enum VisualEvent {
    Frame(VisualFrame),
    Failed(String),
}

#[derive(Debug)]
pub struct VisualEngineError(String);

impl fmt::Display for VisualEngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for VisualEngineError {}

enum VisualCommand {
    SetPreset(VisualPreset),
    SetShipView { orbit: f32, elevation: f32 },
    SetResolution { width: u32, height: u32 },
    PulseKeyboard(f32),
    SetMicrophoneLevel(f32),
    SetActive(bool),
    Shutdown,
}

pub struct VisualEngine {
    commands: mpsc::Sender<VisualCommand>,
    events: Option<async_mpsc::Receiver<VisualEvent>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl VisualEngine {
    pub fn start(config: VisualEngineConfig) -> Result<Self, VisualEngineError> {
        if config.width == 0 || config.height == 0 {
            return Err(VisualEngineError(
                "visual renderer dimensions must be non-zero".into(),
            ));
        }
        if config.frames_per_second == 0 {
            return Err(VisualEngineError(
                "visual renderer frame rate must be non-zero".into(),
            ));
        }
        if config.idle_frames_per_second == 0
            || config.idle_frames_per_second > config.frames_per_second
        {
            return Err(VisualEngineError(
                "visual renderer idle frame rate must be within its active frame rate".into(),
            ));
        }

        let (command_sender, command_receiver) = mpsc::channel();
        let (event_sender, event_receiver) = async_mpsc::channel(2);
        let worker = thread::Builder::new()
            .name("gsv-visual-renderer".into())
            .spawn(move || {
                if let Err(error) = render_loop(config, command_receiver, &event_sender) {
                    let _ = event_sender.try_send(VisualEvent::Failed(error));
                }
            })
            .map_err(|error| {
                VisualEngineError(format!("could not start visual renderer: {error}"))
            })?;

        Ok(Self {
            commands: command_sender,
            events: Some(event_receiver),
            worker: Some(worker),
        })
    }

    pub fn take_events(&mut self) -> Result<async_mpsc::Receiver<VisualEvent>, VisualEngineError> {
        self.events
            .take()
            .ok_or_else(|| VisualEngineError("visual event stream was already taken".into()))
    }

    pub fn set_preset(&self, preset: VisualPreset) -> Result<(), VisualEngineError> {
        self.commands
            .send(VisualCommand::SetPreset(preset))
            .map_err(|_| VisualEngineError("visual renderer has stopped".into()))
    }

    pub fn set_ship_view(&self, orbit: f32, elevation: f32) -> Result<(), VisualEngineError> {
        self.commands
            .send(VisualCommand::SetShipView { orbit, elevation })
            .map_err(|_| VisualEngineError("visual renderer has stopped".into()))
    }

    pub fn set_resolution(&self, width: u32, height: u32) -> Result<(), VisualEngineError> {
        if width == 0 || height == 0 {
            return Err(VisualEngineError(
                "visual renderer dimensions must be non-zero".into(),
            ));
        }
        self.commands
            .send(VisualCommand::SetResolution { width, height })
            .map_err(|_| VisualEngineError("visual renderer has stopped".into()))
    }

    pub fn pulse_keyboard(&self, strength: f32) -> Result<(), VisualEngineError> {
        let strength = validate_input_level("keyboard impulse", strength)?;
        self.commands
            .send(VisualCommand::PulseKeyboard(strength))
            .map_err(|_| VisualEngineError("visual renderer has stopped".into()))
    }

    pub fn set_microphone_level(&self, level: f32) -> Result<(), VisualEngineError> {
        let level = validate_input_level("microphone level", level)?;
        self.commands
            .send(VisualCommand::SetMicrophoneLevel(level))
            .map_err(|_| VisualEngineError("visual renderer has stopped".into()))
    }

    pub fn set_active(&self, active: bool) -> Result<(), VisualEngineError> {
        self.commands
            .send(VisualCommand::SetActive(active))
            .map_err(|_| VisualEngineError("visual renderer has stopped".into()))
    }
}

impl Drop for VisualEngine {
    fn drop(&mut self) {
        let _ = self.commands.send(VisualCommand::Shutdown);
        self.events.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct VisualUniforms {
    resolution_time_energy: [f32; 4],
    input: [f32; 4],
    accent: [f32; 4],
    shape: [f32; 4],
    behavior: [f32; 4],
    activity: [f32; 4],
    activity2: [f32; 4],
    ship_view_materialization_propulsion: [f32; 4],
}

#[derive(Clone, Copy, Debug, Default)]
struct InputResponse {
    keyboard_drive: f32,
    keyboard_envelope: f32,
    microphone_target: f32,
    microphone_envelope: f32,
    microphone_hold: f32,
}

impl InputResponse {
    fn pulse_keyboard(&mut self, strength: f32) {
        self.keyboard_drive = (self.keyboard_drive + strength * 0.55).min(1.0);
    }

    fn set_microphone_level(&mut self, level: f32) {
        self.microphone_target = level;
        self.microphone_hold = if level > INPUT_ACTIVITY_THRESHOLD {
            MICROPHONE_HOLD_SECONDS
        } else {
            0.0
        };
    }

    fn advance(&mut self, delta_seconds: f32) {
        self.keyboard_drive *= (-delta_seconds * KEYBOARD_DRIVE_DECAY).exp();
        if self.keyboard_drive < INPUT_ACTIVITY_THRESHOLD * 0.2 {
            self.keyboard_drive = 0.0;
        }
        let keyboard_rate = if self.keyboard_drive > self.keyboard_envelope {
            KEYBOARD_ATTACK
        } else {
            KEYBOARD_RELEASE
        };
        self.keyboard_envelope = approach_value(
            self.keyboard_envelope,
            self.keyboard_drive,
            keyboard_rate,
            delta_seconds,
        );
        if self.microphone_hold > 0.0 {
            self.microphone_hold = (self.microphone_hold - delta_seconds).max(0.0);
        } else {
            self.microphone_target *= (-delta_seconds * MICROPHONE_DRIVE_DECAY).exp();
            if self.microphone_target < INPUT_ACTIVITY_THRESHOLD * 0.2 {
                self.microphone_target = 0.0;
            }
        }
        let microphone_rate = if self.microphone_target > self.microphone_envelope {
            MICROPHONE_ATTACK
        } else {
            MICROPHONE_RELEASE
        };
        self.microphone_envelope = approach_value(
            self.microphone_envelope,
            self.microphone_target,
            microphone_rate,
            delta_seconds,
        );
        if self.keyboard_envelope < INPUT_ACTIVITY_THRESHOLD * 0.2 {
            self.keyboard_envelope = 0.0;
        }
        if self.microphone_target == 0.0
            && self.microphone_envelope < INPUT_ACTIVITY_THRESHOLD * 0.2
        {
            self.microphone_envelope = 0.0;
        }
    }

    fn is_active(self) -> bool {
        self.keyboard_drive > INPUT_ACTIVITY_THRESHOLD
            || self.keyboard_envelope > INPUT_ACTIVITY_THRESHOLD
            || self.microphone_target > INPUT_ACTIVITY_THRESHOLD
            || self.microphone_envelope > INPUT_ACTIVITY_THRESHOLD
    }

    fn uniforms(self) -> [f32; 4] {
        [self.keyboard_envelope, self.microphone_envelope, 0.0, 0.0]
    }

    fn clear(&mut self) {
        *self = Self::default();
    }
}

fn approach_value(current: f32, target: f32, rate: f32, delta_seconds: f32) -> f32 {
    current + (target - current) * (1.0 - (-delta_seconds * rate).exp())
}

fn validate_input_level(label: &str, value: f32) -> Result<f32, VisualEngineError> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err(VisualEngineError(format!(
            "visual renderer {label} must be between zero and one"
        )));
    }
    Ok(value)
}

#[derive(Clone, Copy)]
struct VisualRecipe {
    accent: [f32; 4],
    shape: [f32; 4],
    behavior: [f32; 4],
    activity: [f32; 4],
    activity2: [f32; 4],
    materialization: f32,
    propulsion: f32,
}

impl VisualRecipe {
    fn for_preset(preset: VisualPreset) -> Self {
        let listening_shape = [1.0, 0.0, 0.0, 0.92];
        match preset {
            VisualPreset::Listening => Self {
                accent: ACCENT,
                shape: listening_shape,
                behavior: [0.0, 0.0, 0.0, 0.0],
                activity: [0.0; 4],
                activity2: [0.0; 4],
                materialization: 1.0,
                propulsion: 0.0,
            },
            VisualPreset::Thinking => Self {
                accent: VIOLET,
                shape: listening_shape,
                behavior: [1.0, 1.0, 1.0, 0.0],
                activity: [0.0; 4],
                activity2: [0.0; 4],
                materialization: 1.0,
                propulsion: 0.0,
            },
            VisualPreset::Reading => Self {
                accent: READING_BLUE,
                shape: [0.78, 0.0, 0.0, 0.92],
                behavior: [0.34, 0.38, 0.72, 0.0],
                activity: [1.0, 0.0, 0.0, 0.0],
                activity2: [0.0; 4],
                materialization: 1.0,
                propulsion: 0.0,
            },
            VisualPreset::Writing => Self {
                accent: WRITING_LILAC,
                shape: [0.80, 0.0, 0.0, 0.92],
                behavior: [0.38, 0.46, 0.86, 0.0],
                activity: [0.0, 0.0, 1.0, 0.0],
                activity2: [0.0; 4],
                materialization: 1.0,
                propulsion: 0.0,
            },
            VisualPreset::Deleting => Self {
                accent: DELETING_VIOLET,
                shape: [0.80, 0.0, 0.0, 0.92],
                behavior: [0.46, 0.60, 0.92, 0.0],
                activity: [0.0; 4],
                activity2: [0.0, 1.0, 0.0, 0.0],
                materialization: 1.0,
                propulsion: 0.0,
            },
            VisualPreset::DeletingShredder => Self {
                accent: SHREDDING_LILAC,
                shape: [0.82, 0.0, 0.0, 0.92],
                behavior: [0.50, 0.58, 0.94, 0.0],
                activity: [0.0; 4],
                activity2: [0.0, 0.0, 1.0, 0.0],
                materialization: 1.0,
                propulsion: 0.0,
            },
            VisualPreset::Searching => Self {
                accent: SEARCHING_BLUE,
                shape: [0.84, 0.0, 0.0, 0.92],
                behavior: [0.40, 0.54, 0.84, 0.0],
                activity: [0.0, 1.0, 0.0, 0.0],
                activity2: [0.0; 4],
                materialization: 1.0,
                propulsion: 0.0,
            },
            VisualPreset::Executing => Self {
                accent: EXECUTING_VIOLET,
                shape: [0.86, 0.0, 0.0, 0.92],
                behavior: [0.36, 0.62, 0.92, 0.0],
                activity: [0.0, 0.0, 0.0, 1.0],
                activity2: [0.0; 4],
                materialization: 1.0,
                propulsion: 0.0,
            },
            VisualPreset::Delegating => Self {
                accent: DELEGATING_VIOLET,
                shape: [0.92, 0.0, 0.0, 0.92],
                behavior: [0.82, 0.74, 0.90, 0.0],
                activity: [0.0; 4],
                activity2: [1.0, 0.0, 0.0, 0.0],
                materialization: 1.0,
                propulsion: 0.0,
            },
            VisualPreset::Speaking => Self {
                accent: BLUE,
                shape: listening_shape,
                behavior: [0.0, 0.32, 0.82, 1.0],
                activity: [0.0; 4],
                activity2: [0.0; 4],
                materialization: 1.0,
                propulsion: 0.0,
            },
            VisualPreset::ShipHologram => Self {
                accent: ACCENT,
                shape: [1.0, 0.0, 1.0, 0.92],
                behavior: [0.0, 0.0, 0.0, 0.0],
                activity: [0.0; 4],
                activity2: [0.0; 4],
                materialization: 0.0,
                propulsion: 0.0,
            },
            VisualPreset::ShipPhysical => Self {
                accent: ACCENT,
                shape: [1.0, 0.0, 1.0, 0.92],
                behavior: [0.0, 0.0, 0.0, 0.0],
                activity: [0.0; 4],
                activity2: [0.0; 4],
                materialization: 1.0,
                propulsion: 0.0,
            },
            VisualPreset::ShipArmed => Self {
                accent: ACCENT,
                shape: [1.0, 0.0, 1.0, 0.92],
                behavior: [0.0, 0.0, 0.0, 0.0],
                activity: [0.0; 4],
                activity2: [0.0; 4],
                materialization: 1.0,
                propulsion: 1.0,
            },
        }
    }

    fn approach(&mut self, target: Self, delta_seconds: f32) {
        let blend = 1.0 - (-delta_seconds * 3.2).exp();
        lerp_slice(&mut self.accent, target.accent, blend);
        lerp_slice(&mut self.shape, target.shape, blend);
        lerp_slice(&mut self.behavior, target.behavior, blend);
        lerp_slice(&mut self.activity, target.activity, blend);
        lerp_slice(&mut self.activity2, target.activity2, blend);
        self.materialization +=
            (target.materialization - self.materialization) * (1.0 - (-delta_seconds * 2.6).exp());
        self.propulsion +=
            (target.propulsion - self.propulsion) * (1.0 - (-delta_seconds * 3.5).exp());
    }
}

fn lerp_slice<const LENGTH: usize>(values: &mut [f32; LENGTH], target: [f32; LENGTH], blend: f32) {
    for (value, target_value) in values.iter_mut().zip(target) {
        *value += (target_value - *value) * blend;
    }
}

struct GpuRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    uniform_buffer: wgpu::Buffer,
    uniform_bind_group: wgpu::BindGroup,
    target: wgpu::Texture,
    readback: wgpu::Buffer,
    width: u32,
    height: u32,
    padded_bytes_per_row: u32,
}

impl GpuRenderer {
    fn new(width: u32, height: u32) -> Result<Self, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
        }))
        .map_err(|error| format!("no compatible GPU adapter: {error}"))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("GSV visual renderer"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
        }))
        .map_err(|error| format!("could not open GPU device: {error}"))?;

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("GSV visual uniforms layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("GSV visual uniforms"),
            contents: bytemuck::bytes_of(&VisualUniforms::zeroed()),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("GSV visual uniforms"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
        });

        let vertex_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("GSV fullscreen vertex shader"),
            source: wgpu::ShaderSource::Wgsl(FULLSCREEN_VERTEX_SHADER.into()),
        });
        let fragment_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("GSV assistant fragment shader"),
            source: wgpu::ShaderSource::Glsl {
                shader: shader::assistant_glsl(),
                stage: wgpu::naga::ShaderStage::Fragment,
                defines: &[],
            },
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("GSV visual pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("GSV visual pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &vertex_shader,
                entry_point: Some("main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &fragment_shader,
                entry_point: Some("main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Bgra8UnormSrgb,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("GSV visual target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Bgra8UnormSrgb,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let bytes_per_row = width * 4;
        let padded_bytes_per_row = bytes_per_row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("GSV visual readback"),
            size: u64::from(padded_bytes_per_row) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        Ok(Self {
            device,
            queue,
            pipeline,
            uniform_buffer,
            uniform_bind_group,
            target,
            readback,
            width,
            height,
            padded_bytes_per_row,
        })
    }

    fn render(&self, uniforms: &VisualUniforms) -> Result<Vec<u8>, String> {
        self.queue
            .write_buffer(&self.uniform_buffer, 0, bytemuck::bytes_of(uniforms));
        let target_view = self
            .target
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("GSV visual frame"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("GSV visual pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.uniform_bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.target,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &self.readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(self.padded_bytes_per_row),
                    rows_per_image: Some(self.height),
                },
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(Some(encoder.finish()));

        let slice = self.readback.slice(..);
        let (sender, receiver) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        self.device
            .poll(wgpu::PollType::Wait)
            .map_err(|error| format!("GPU poll failed: {error}"))?;
        receiver
            .recv()
            .map_err(|_| "GPU mapping callback was dropped".to_string())?
            .map_err(|error| format!("could not map rendered frame: {error}"))?;

        let mapped = slice.get_mapped_range();
        let bytes_per_row = (self.width * 4) as usize;
        let mut output = vec![0; bytes_per_row * self.height as usize];
        for row in 0..self.height as usize {
            let mapped_start = row * self.padded_bytes_per_row as usize;
            let output_start = row * bytes_per_row;
            output[output_start..output_start + bytes_per_row]
                .copy_from_slice(&mapped[mapped_start..mapped_start + bytes_per_row]);
        }
        drop(mapped);
        self.readback.unmap();
        Ok(output)
    }
}

struct RendererState {
    target: VisualPreset,
    orbit: f32,
    elevation: f32,
    width: u32,
    height: u32,
    input_response: InputResponse,
    active: bool,
}

fn render_loop(
    config: VisualEngineConfig,
    commands: mpsc::Receiver<VisualCommand>,
    events: &async_mpsc::Sender<VisualEvent>,
) -> Result<(), String> {
    let mut state = RendererState {
        target: config.initial_preset,
        orbit: 0.0,
        elevation: 0.0,
        width: config.width,
        height: config.height,
        input_response: InputResponse::default(),
        active: config.initially_active,
    };
    let mut renderer = GpuRenderer::new(state.width, state.height)?;
    let started = Instant::now();
    let mut previous_frame = started;
    let mut next_frame = started;
    let mut sequence = 0;
    let mut recipe = VisualRecipe::for_preset(state.target);

    loop {
        if !state.active {
            let Ok(command) = commands.recv() else {
                return Ok(());
            };
            let mut render_requested = false;
            if !apply_command(command, &mut state, &mut render_requested) {
                return Ok(());
            }
            if state.active {
                let resumed = Instant::now();
                previous_frame = resumed;
                next_frame = resumed;
            }
            continue;
        }

        let mut render_requested = false;
        for command in commands.try_iter() {
            if !apply_command(command, &mut state, &mut render_requested) {
                return Ok(());
            }
        }
        if !state.active {
            continue;
        }
        if render_requested {
            next_frame = Instant::now();
        }
        if renderer.width != state.width || renderer.height != state.height {
            renderer = GpuRenderer::new(state.width, state.height)?;
        }

        let now = Instant::now();
        let frames_per_second =
            if state.target == VisualPreset::Listening && !state.input_response.is_active() {
                config.idle_frames_per_second
            } else {
                config.frames_per_second
            };
        let frame_interval = Duration::from_secs_f64(1.0 / f64::from(frames_per_second));
        if now < next_frame {
            thread::sleep((next_frame - now).min(Duration::from_millis(4)));
            continue;
        }
        let delta_seconds = (now - previous_frame).as_secs_f32().min(0.1);
        previous_frame = now;
        next_frame += frame_interval;
        if next_frame < now {
            next_frame = now + frame_interval;
        }

        recipe.approach(VisualRecipe::for_preset(state.target), delta_seconds);
        state.input_response.advance(delta_seconds);
        let phase = started.elapsed().as_secs_f32() % LOOP_SECONDS;
        let loop_phase = phase / LOOP_SECONDS * std::f32::consts::TAU;
        let energy = match state.target {
            VisualPreset::Thinking => {
                0.25 + 0.11 * (loop_phase * 2.0).sin().abs()
                    + 0.05 * (loop_phase * 3.0 + 0.9).sin().abs()
            }
            VisualPreset::Reading => {
                0.18 + 0.10 * (loop_phase * 3.0).sin().abs()
                    + 0.04 * (loop_phase * 5.0 + 0.7).sin().abs()
            }
            VisualPreset::Writing => {
                0.22 + 0.12 * (loop_phase * 4.0).sin().abs()
                    + 0.07 * (loop_phase * 9.0 + 0.5).sin().abs()
            }
            VisualPreset::Deleting => {
                0.28 + 0.14 * (loop_phase * 3.0).sin().abs()
                    + 0.08 * (loop_phase * 8.0 + 0.6).sin().abs()
            }
            VisualPreset::DeletingShredder => {
                0.30 + 0.15 * (loop_phase * 4.0).sin().abs()
                    + 0.08 * (loop_phase * 9.0 + 0.4).sin().abs()
            }
            VisualPreset::Searching => {
                0.24 + 0.13 * (loop_phase * 3.0).sin().abs()
                    + 0.08 * (loop_phase * 8.0 + 0.8).sin().abs()
            }
            VisualPreset::Executing => {
                0.34 + 0.18 * (loop_phase * 4.0).sin().abs()
                    + 0.08 * (loop_phase * 7.0 + 0.4).sin().abs()
            }
            VisualPreset::Delegating => {
                0.28 + 0.14 * (loop_phase * 3.0).sin().abs()
                    + 0.06 * (loop_phase * 7.0 + 0.6).sin().abs()
            }
            VisualPreset::Speaking => {
                let carrier = (phase * 5.7).sin() * 0.5 + (phase * 11.3 + 0.8).sin() * 0.3;
                (0.42 + carrier.abs() * 0.58).clamp(0.0, 1.0)
            }
            VisualPreset::Listening => (0.10 + 0.08 * (phase * 1.4).sin().abs()).clamp(0.0, 1.0),
            _ => 0.06,
        };
        let uniforms = VisualUniforms {
            resolution_time_energy: [state.width as f32, state.height as f32, phase, energy],
            input: state.input_response.uniforms(),
            accent: recipe.accent,
            shape: recipe.shape,
            behavior: recipe.behavior,
            activity: recipe.activity,
            activity2: recipe.activity2,
            ship_view_materialization_propulsion: [
                state.orbit,
                state.elevation,
                recipe.materialization,
                recipe.propulsion,
            ],
        };
        let render_started = Instant::now();
        let bgra = renderer.render(&uniforms)?;
        sequence += 1;
        let event = VisualEvent::Frame(VisualFrame {
            width: state.width,
            height: state.height,
            sequence,
            render_time: render_started.elapsed(),
            bgra,
        });
        match events.try_send(event) {
            Ok(()) | Err(async_mpsc::error::TrySendError::Full(_)) => {}
            Err(async_mpsc::error::TrySendError::Closed(_)) => return Ok(()),
        }
    }
}

fn apply_command(
    command: VisualCommand,
    state: &mut RendererState,
    render_requested: &mut bool,
) -> bool {
    match command {
        VisualCommand::SetPreset(preset) => state.target = preset,
        VisualCommand::SetShipView {
            orbit: new_orbit,
            elevation: new_elevation,
        } => {
            state.orbit = new_orbit;
            state.elevation = new_elevation;
        }
        VisualCommand::SetResolution { width, height } => {
            state.width = width;
            state.height = height;
        }
        VisualCommand::PulseKeyboard(strength) => {
            state.input_response.pulse_keyboard(strength);
            *render_requested = true;
        }
        VisualCommand::SetMicrophoneLevel(level) => {
            let was_active = state.input_response.is_active();
            state.input_response.set_microphone_level(level);
            *render_requested |= !was_active && state.input_response.is_active();
        }
        VisualCommand::SetActive(new_active) => {
            state.active = new_active;
            if !new_active {
                state.input_response.clear();
            }
        }
        VisualCommand::Shutdown => return false,
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_control_pauses_without_losing_visual_state() {
        let mut state = RendererState {
            target: VisualPreset::Listening,
            orbit: 0.0,
            elevation: 0.0,
            width: 512,
            height: 512,
            input_response: InputResponse::default(),
            active: true,
        };
        let mut render_requested = false;

        assert!(apply_command(
            VisualCommand::SetActive(false),
            &mut state,
            &mut render_requested,
        ));
        assert!(!state.active);
        assert!(apply_command(
            VisualCommand::SetPreset(VisualPreset::Searching),
            &mut state,
            &mut render_requested,
        ));
        assert_eq!(state.target, VisualPreset::Searching);
        assert!(!state.active);
        assert!(apply_command(
            VisualCommand::SetActive(true),
            &mut state,
            &mut render_requested,
        ));
        assert!(state.active);
        assert_eq!(state.target, VisualPreset::Searching);
        assert!(apply_command(
            VisualCommand::SetResolution {
                width: 768,
                height: 768,
            },
            &mut state,
            &mut render_requested,
        ));
        assert_eq!((state.width, state.height), (768, 768));
        assert!(!apply_command(
            VisualCommand::Shutdown,
            &mut state,
            &mut render_requested,
        ));
    }

    #[test]
    fn keyboard_impulses_attack_quickly_and_release_smoothly() {
        let mut response = InputResponse::default();
        response.pulse_keyboard(0.8);
        assert!(response.is_active());
        assert_eq!(response.keyboard_envelope, 0.0);

        response.advance(1.0 / 30.0);
        let attacked = response.keyboard_envelope;
        assert!(attacked > 0.1);
        assert!(attacked < 0.8);

        response.advance(1.0 / 30.0);
        assert!(response.keyboard_envelope > 0.0);
        for _ in 0..90 {
            response.advance(1.0 / 30.0);
        }
        assert_eq!(response.keyboard_envelope, 0.0);
        assert!(!response.is_active());
    }

    #[test]
    fn microphone_levels_have_distinct_attack_and_release() {
        let mut response = InputResponse::default();
        response.set_microphone_level(0.9);
        response.advance(1.0 / 30.0);
        let attacked = response.microphone_envelope;
        assert!(attacked > 0.3);
        assert!(attacked < 0.9);

        response.set_microphone_level(0.0);
        response.advance(1.0 / 30.0);
        assert!(response.microphone_envelope < attacked);
        assert!(response.microphone_envelope > 0.0);

        response.set_microphone_level(0.9);
        for _ in 0..120 {
            response.advance(1.0 / 30.0);
        }
        assert_eq!(response.microphone_target, 0.0);
        assert_eq!(response.microphone_envelope, 0.0);
        assert!(!response.is_active());
    }

    #[test]
    fn input_levels_reject_non_finite_and_out_of_range_values() {
        assert!(validate_input_level("test", f32::NAN).is_err());
        assert!(validate_input_level("test", -0.01).is_err());
        assert!(validate_input_level("test", 1.01).is_err());
        assert_eq!(
            validate_input_level("test", 0.5).expect("a unit input level should be valid"),
            0.5
        );
    }
}
