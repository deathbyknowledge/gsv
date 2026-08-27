use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use gesture_engine::control::{ControlState, VoiceControlPolicy};
use gesture_engine::observation::FrameView;
use gesture_engine::vision::{ModelData, TractHandTracker};
use jni::objects::{JByteArray, JByteBuffer, JClass};
use jni::sys::{jboolean, jint, jlong};
use jni::JNIEnv;

use crate::rgba::rgba_to_oriented_rgb;
use crate::semantic::{pack_error, pack_output};

const ERROR_INVALID_HANDLE: u8 = 1;
const ERROR_INVALID_BUFFER: u8 = 2;
const ERROR_INVALID_FRAME: u8 = 3;
const ERROR_INVALID_STATE: u8 = 4;
const ERROR_INFERENCE: u8 = 5;
const ERROR_PANIC: u8 = 6;
const MAX_MODEL_BYTES: usize = 16 * 1024 * 1024;

struct Engine {
    tracker: TractHandTracker,
    policy: VoiceControlPolicy<u64>,
    state: ControlState<u64>,
    state_revision: u64,
    clock: StreamClock,
    last_intent_request_id: Option<u64>,
}

impl Engine {
    fn load(palm: &[u8], landmarks: &[u8]) -> Option<Self> {
        if palm.is_empty()
            || landmarks.is_empty()
            || palm.len() > MAX_MODEL_BYTES
            || landmarks.len() > MAX_MODEL_BYTES
        {
            return None;
        }
        let models = ModelData::new(palm, landmarks);
        let tracker = TractHandTracker::load(&models).ok()?;
        let state = ControlState::Standby;
        Some(Self {
            tracker,
            policy: VoiceControlPolicy::new(state),
            state,
            state_revision: 0,
            clock: StreamClock::default(),
            last_intent_request_id: None,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn process(
        &mut self,
        rgba: &[u8],
        width: u32,
        height: u32,
        row_stride: usize,
        pixel_stride: usize,
        rotation_degrees: i32,
        sequence: u64,
        timestamp_ns: u64,
        state: ControlState<u64>,
        state_revision: u64,
    ) -> i64 {
        if sequence == 0 {
            return pack_error(ERROR_INVALID_FRAME);
        }
        let packed = match rgba_to_oriented_rgb(
            rgba,
            width,
            height,
            row_stride,
            pixel_stride,
            rotation_degrees,
        ) {
            Ok(frame) => frame,
            Err(_) => return pack_error(ERROR_INVALID_FRAME),
        };
        let Some((captured_at, timestamp_ms)) = self.clock.map(timestamp_ns) else {
            return pack_error(ERROR_INVALID_FRAME);
        };
        if self.state != state || self.state_revision != state_revision {
            self.policy.synchronize_state(state);
            self.state = state;
            self.state_revision = state_revision;
        }
        let frame = FrameView {
            sequence,
            captured_at,
            width: packed.width,
            height: packed.height,
            rgb: packed.rgb,
        };
        let observation = match self.tracker.recognize(&frame, timestamp_ms) {
            Ok(observation) => observation,
            Err(_) => return pack_error(ERROR_INFERENCE),
        };
        let output = self.policy.observe(&frame, &observation);
        let result = pack_output(output, observation.hands.len(), observation.inference_time);
        self.last_intent_request_id = result.request_id;
        result.packed
    }
}

#[derive(Default)]
struct StreamClock {
    origin: Option<(u64, Instant)>,
    last_timestamp_ns: Option<u64>,
    last_tracker_ms: Option<i64>,
}

impl StreamClock {
    fn map(&mut self, timestamp_ns: u64) -> Option<(Instant, i64)> {
        if timestamp_ns == 0
            || self
                .last_timestamp_ns
                .is_some_and(|previous| timestamp_ns <= previous)
        {
            return None;
        }
        let (origin_timestamp_ns, origin_instant) = *self
            .origin
            .get_or_insert_with(|| (timestamp_ns, Instant::now()));
        let elapsed_ns = timestamp_ns.checked_sub(origin_timestamp_ns)?;
        let captured_at = origin_instant.checked_add(Duration::from_nanos(elapsed_ns))?;
        let elapsed_ms = i64::try_from(elapsed_ns / 1_000_000).ok()?;
        let tracker_ms = self
            .last_tracker_ms
            .map_or(elapsed_ms, |previous| elapsed_ms.max(previous + 1));
        self.last_timestamp_ns = Some(timestamp_ns);
        self.last_tracker_ms = Some(tracker_ms);
        Some((captured_at, tracker_ms))
    }
}

struct Registry {
    next_handle: u64,
    engines: HashMap<u64, Engine>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            next_handle: 1,
            engines: HashMap::new(),
        }
    }
}

fn registry() -> MutexGuard<'static, Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    match REGISTRY
        .get_or_init(|| Mutex::new(Registry::default()))
        .lock()
    {
        Ok(registry) => registry,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn control_state(code: jint, request_id: jlong, muted: jboolean) -> Option<ControlState<u64>> {
    match code {
        0 => Some(ControlState::Standby),
        1 => Some(ControlState::Active {
            voice_request_id: u64::try_from(request_id).ok()?,
            muted: muted != 0,
        }),
        2 => Some(ControlState::Disabled),
        _ => None,
    }
}

#[no_mangle]
pub extern "system" fn Java_com_humansandmachines_gsv_wear_gesture_NativeGestureEngine_nativeCreate(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    palm: JByteArray<'_>,
    landmarks: JByteArray<'_>,
) -> jlong {
    catch_unwind(AssertUnwindSafe(|| {
        let palm = env.convert_byte_array(&palm).ok()?;
        let landmarks = env.convert_byte_array(&landmarks).ok()?;
        let engine = Engine::load(&palm, &landmarks)?;
        let mut registry = registry();
        let handle = registry.next_handle;
        registry.next_handle = registry.next_handle.wrapping_add(1).max(1);
        registry.engines.insert(handle, engine);
        i64::try_from(handle).ok()
    }))
    .ok()
    .flatten()
    .unwrap_or(0)
}

#[no_mangle]
pub extern "system" fn Java_com_humansandmachines_gsv_wear_gesture_NativeGestureEngine_nativeDestroy(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if let Ok(handle) = u64::try_from(handle) {
            registry().engines.remove(&handle);
        }
    }));
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "system" fn Java_com_humansandmachines_gsv_wear_gesture_NativeGestureEngine_nativeProcess(
    env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
    buffer: JByteBuffer<'_>,
    buffer_offset: jint,
    buffer_length: jint,
    width: jint,
    height: jint,
    row_stride: jint,
    pixel_stride: jint,
    rotation_degrees: jint,
    sequence: jlong,
    timestamp_ns: jlong,
    state_code: jint,
    request_id: jlong,
    muted: jboolean,
    state_revision: jlong,
) -> jlong {
    catch_unwind(AssertUnwindSafe(|| {
        let handle = u64::try_from(handle).map_err(|_| ERROR_INVALID_HANDLE)?;
        let offset = usize::try_from(buffer_offset).map_err(|_| ERROR_INVALID_BUFFER)?;
        let length = usize::try_from(buffer_length).map_err(|_| ERROR_INVALID_BUFFER)?;
        let width = u32::try_from(width).map_err(|_| ERROR_INVALID_FRAME)?;
        let height = u32::try_from(height).map_err(|_| ERROR_INVALID_FRAME)?;
        let row_stride = usize::try_from(row_stride).map_err(|_| ERROR_INVALID_FRAME)?;
        let pixel_stride = usize::try_from(pixel_stride).map_err(|_| ERROR_INVALID_FRAME)?;
        let sequence = u64::try_from(sequence).map_err(|_| ERROR_INVALID_FRAME)?;
        let timestamp_ns = u64::try_from(timestamp_ns).map_err(|_| ERROR_INVALID_FRAME)?;
        let state_revision = u64::try_from(state_revision).map_err(|_| ERROR_INVALID_STATE)?;
        let state = control_state(state_code, request_id, muted).ok_or(ERROR_INVALID_STATE)?;
        let capacity = env
            .get_direct_buffer_capacity(&buffer)
            .map_err(|_| ERROR_INVALID_BUFFER)?;
        let end = offset.checked_add(length).ok_or(ERROR_INVALID_BUFFER)?;
        if length == 0 || end > capacity {
            return Err(ERROR_INVALID_BUFFER);
        }
        let address = env
            .get_direct_buffer_address(&buffer)
            .map_err(|_| ERROR_INVALID_BUFFER)?;
        // CameraX retains the direct buffer for the duration of this JNI call,
        // and the validated offset/length stay within its reported capacity.
        let rgba = unsafe { slice::from_raw_parts(address.add(offset), length) };
        let mut registry = registry();
        let engine = registry
            .engines
            .get_mut(&handle)
            .ok_or(ERROR_INVALID_HANDLE)?;
        Ok(engine.process(
            rgba,
            width,
            height,
            row_stride,
            pixel_stride,
            rotation_degrees,
            sequence,
            timestamp_ns,
            state,
            state_revision,
        ))
    }))
    .map_or_else(
        |_| pack_error(ERROR_PANIC),
        |result: Result<i64, u8>| result.unwrap_or_else(pack_error),
    )
}

#[no_mangle]
pub extern "system" fn Java_com_humansandmachines_gsv_wear_gesture_NativeGestureEngine_nativeLastIntentRequestId(
    _env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) -> jlong {
    catch_unwind(AssertUnwindSafe(|| {
        let handle = u64::try_from(handle).ok()?;
        let registry = registry();
        let request_id = registry.engines.get(&handle)?.last_intent_request_id?;
        i64::try_from(request_id).ok()
    }))
    .ok()
    .flatten()
    .unwrap_or(0)
}
